import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Host } from "../src/host.js";
import { AgentSources } from "../src/agent-sources.js";
import type { EventSocket } from "../src/event-socket.js";
import { FleetCapacity } from "../src/server/fleet-capacity.js";
import { COMPLETE_WORKSPACE_CAPABILITIES } from "../src/shared/workspace-events.js";
import {
  WORKSPACE_MULTIPLEX_PATH,
  WorkspaceMuxResponse,
} from "../src/shared/workspace-multiplex.js";

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error("Fixture subscription did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const reset = (epoch: string, cursor = 0) => ({
  v: 3,
  type: "reset",
  epoch,
  cursor,
  build: "fixture",
  buildIdentity: null,
  capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
  serverNow: Date.now(),
  nextDeadline: null,
});
const event = (epoch: string, cursor: number) => ({
  v: 3,
  type: "events",
  epoch,
  cursor,
  events: [
    {
      id: cursor,
      event: { type: "invalidate", scope: { kind: "collection", id: "feed" } },
    },
  ],
});

function fixtureHost(directory: string) {
  return new Host(directory, {
    harness: "codex",
    version: "fixture",
    project: directory,
    billing: { mode: "existing", description: "Fixture" },
    capabilities: {
      approvals: true,
      questions: true,
      resume: true,
      liveAttach: false,
      terminal: false,
    },
  });
}
async function pair(host: Host, name: string) {
  const link = new URL(host.pair().url);
  const response = await fetch(host.origin + "/pair", {
    method: "POST",
    headers: { origin: host.origin, "content-type": "application/json" },
    body: JSON.stringify({
      secret: new URLSearchParams(link.hash.slice(1)).get("pair"),
      name,
    }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0];
}
function subscribe(
  ws: WebSocket,
  source: string,
  {
    id = randomUUID(),
    epoch = "",
    cursor = 0,
    conversations = [],
  }: {
    id?: string;
    epoch?: string;
    cursor?: number;
    conversations?: string[];
  } = {},
) {
  ws.send(
    JSON.stringify({
      v: 1,
      type: "subscribe",
      id,
      source,
      epoch,
      cursor,
      conversations,
      runs: [],
    }),
  );
  return id;
}

test("measures shared source streams for three and sixteen simulated machines", async (t) => {
  for (const sourceCount of [3, 16]) {
    const dir = await mkdtemp(join(tmpdir(), "loop55-multiplex-measure-"));
    const budget = new FleetCapacity(() => true);
    const host = fixtureHost(dir);
    const sources = Array.from({ length: sourceCount }, (_, i) => String(i));
    const slow = sources.at(-1)!;
    const upstreams = new Map<string, EventSocket>();
    const browsers: WebSocket[] = [];
    const latest = new Map<string, number>();
    let upstreamFrames = 0,
      upstreamBytes = 0,
      receivedFrames = 0,
      receivedBytes = 0;
    let opened = 0,
      firstHealthyMs: number | undefined;
    const before = process.memoryUsage(),
      start = performance.now();
    const send = (
      id: string,
      frame: ReturnType<typeof reset> | ReturnType<typeof event>,
    ) => {
      const text = JSON.stringify(frame);
      upstreamFrames++;
      upstreamBytes += Buffer.byteLength(text);
      upstreams.get(id)!.send(text);
    };
    const open = (socket: EventSocket, id: string) => {
      const release = id === "0" ? () => {} : budget.acquire("outbound", id);
      assert(
        release,
        "Synthetic source must obtain production outbound capacity",
      );
      opened++;
      upstreams.set(id, socket);
      socket.once("close", () => {
        upstreams.delete(id);
        release();
      });
      if (id !== slow) send(id, reset("measured:" + id));
    };
    host.workspace = {
      fleetCapacity: budget,
      http: (_req, res) => res.end("{}"),
      connect: (socket) => {
        open(socket, "0");
        return () => {};
      },
      status: () => ({}),
      admin: async () => ({}),
      originChanged: () => {},
      sources: new AgentSources([
        {
          kind: "fixture",
          current: (id) => id,
          discover: async () =>
            sources.slice(1).map((id) => ({ id, name: id })),
          events: async (socket, id) => open(socket, id),
          proxy: async () => {},
        },
      ]),
    };
    try {
      await host.listen();
      const cookie = await pair(host, "Measured fixture");
      const subscriptions = new Map<string, string>();
      for (let viewer = 0; viewer < 3; viewer++) {
        const ws = new WebSocket(
          host.origin.replace("http:", "ws:") + WORKSPACE_MULTIPLEX_PATH,
          { headers: { origin: host.origin, cookie } },
        );
        browsers.push(ws);
        ws.on("message", (raw) => {
          const frame = WorkspaceMuxResponse.parse(JSON.parse(raw.toString()));
          receivedFrames++;
          receivedBytes += raw.toString().length;
          if (frame.type === "frame") {
            latest.set(frame.id, frame.frame.cursor);
            firstHealthyMs ??= Math.round(performance.now() - start);
          }
        });
        await once(ws, "open");
        for (const source of sources) {
          const id = randomUUID();
          subscriptions.set(`${viewer}:${source}`, id);
          subscribe(ws, source === "0" ? "" : "fixture:" + source, { id });
        }
      }
      await until(() => latest.size === 3 * (sourceCount - 1));
      assert.equal(upstreams.size, sourceCount);
      assert.equal(
        opened,
        sourceCount,
        "All three viewers must share each owning stream",
      );
      assert.equal(budget.snapshot().browser, 3);
      assert.equal(budget.snapshot().outbound, sourceCount - 1);
      for (let viewer = 0; viewer < 3; viewer++)
        assert(!latest.has(subscriptions.get(`${viewer}:${slow}`)!));
      const beforeTraffic = {
        receivedFrames,
        receivedBytes,
        upstreamFrames,
        upstreamBytes,
      };
      for (let cursor = 1; cursor <= 40; cursor++)
        for (const source of sources.slice(0, -1))
          send(source, event("measured:" + source, cursor));
      await until(() => [...latest.values()].every((cursor) => cursor === 40));
      const loaded = budget.snapshot();
      // Each source's 32-entry replay ring must discard old traffic. A cursor
      // older than that ring receives a current reset, not unbounded replay.
      const priorFrames = receivedFrames;
      const stale = subscribe(browsers[0], "", { epoch: "measured:0" });
      await until(() => receivedFrames > priorFrames);
      assert.equal(latest.get(stale), 40);
      assert.equal(receivedFrames - priorFrames, 1);
      for (const ws of browsers) ws.close();
      await until(() => upstreams.size === 0 && budget.snapshot().total === 0);
      t.diagnostic(
        "FLEET_METRIC " +
          JSON.stringify({
            boundary:
              "production Host and source multiplex with synthetic upstreams",
            sourceCount,
            viewers: 3,
            slowSources: 1,
            firstHealthyMs,
            sourceStreamsOpened: opened,
            loaded,
            afterClose: budget.snapshot(),
            eventWorkload: {
              eventsPerHealthySource: 40,
              healthySources: sourceCount - 1,
            },
            traffic: {
              receivedFrames: receivedFrames - beforeTraffic.receivedFrames,
              receivedBytes: receivedBytes - beforeTraffic.receivedBytes,
              upstreamFrames: upstreamFrames - beforeTraffic.upstreamFrames,
              upstreamBytes: upstreamBytes - beforeTraffic.upstreamBytes,
            },
            oldCursorResponseFrames: receivedFrames - priorFrames,
            milliseconds: Math.round(performance.now() - start),
            rssBefore: before.rss,
            rssAfter: process.memoryUsage().rss,
            maxRssBytes: process.resourceUsage().maxRSS * 1024,
            limitations:
              "Loopback browser sockets and synthetic source callbacks; not Cloudflare ingress or live peer authentication. RSS is an observation, not a memory-bound proof.",
          }),
      );
    } finally {
      for (const ws of browsers) ws.terminate();
      await host.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("paired gateway multiplexes sources, shares upstreams, bounds replay and fences changed authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop55-multiplex-"));
  const host = fixtureHost(dir);
  const budget = new FleetCapacity(() => true);
  const open = new Map<string, Set<EventSocket>>(),
    calls = new Map<string, number>(),
    queries = new Map<string, URLSearchParams>();
  let generation = "one";
  const start = (socket: EventSocket, id: string, query?: URLSearchParams) => {
    let group = open.get(id);
    if (!group) open.set(id, (group = new Set()));
    group.add(socket);
    calls.set(id, (calls.get(id) ?? 0) + 1);
    if (query) queries.set(id, query);
    socket.once("close", () => {
      group!.delete(socket);
    });
    if (id !== "slow")
      socket.send(
        JSON.stringify(
          query?.get("epoch")
            ? {
                ...event(query.get("epoch")!, Number(query.get("cursor"))),
                capabilities: COMPLETE_WORKSPACE_CAPABILITIES,
              }
            : reset(id + ":" + generation),
        ),
      );
  };
  host.workspace = {
    fleetCapacity: budget,
    http: (_req, res) => res.end("{}"),
    connect: (socket) => {
      start(socket, "local");
      return () => {};
    },
    status: () => ({}),
    admin: async () => ({}),
    originChanged: () => {},
    sources: new AgentSources([
      {
        kind: "fixture",
        current: () => generation,
        discover: async () => ["one", "slow"].map((id) => ({ id, name: id })),
        events: async (socket, id, query) => {
          start(socket, id, query);
        },
        proxy: async () => {},
      },
    ]),
  };
  const browsers: WebSocket[] = [];
  try {
    await host.listen();
    const connect = async (cookie: string) => {
      const ws = new WebSocket(
        host.origin.replace("http:", "ws:") + WORKSPACE_MULTIPLEX_PATH,
        { headers: { origin: host.origin, cookie } },
      );
      browsers.push(ws);
      const frames: ReturnType<typeof WorkspaceMuxResponse.parse>[] = [];
      ws.on("message", (raw) =>
        frames.push(WorkspaceMuxResponse.parse(JSON.parse(raw.toString()))),
      );
      await once(ws, "open");
      return { ws, frames };
    };
    const a = await connect(await pair(host, "Fixture viewer")),
      b = await connect(await pair(host, "Fixture viewer"));
    const one = subscribe(a.ws, "fixture:one"),
      slow = subscribe(a.ws, "fixture:slow"),
      local = subscribe(a.ws, "");
    const second = subscribe(b.ws, "fixture:one");
    await until(
      () =>
        a.frames.some((f) => f.id === one) &&
        a.frames.some((f) => f.id === local) &&
        b.frames.some((f) => f.id === second),
    );
    assert(
      !a.frames.some((f) => f.id === slow),
      "A slow source must not stall healthy sources",
    );
    assert.equal(calls.get("one"), 1, "Two viewers share one owning stream");
    assert.equal(
      budget.snapshot().browser,
      2,
      "Each browser opens one socket for all its sources",
    );
    let upstream = [...open.get("one")!][0];
    upstream.send(JSON.stringify(event("one:one", 1)));
    await until(
      () =>
        a.frames.some(
          (f) => f.type === "frame" && f.id === one && f.frame.cursor === 1,
        ) &&
        b.frames.some(
          (f) => f.type === "frame" && f.id === second && f.frame.cursor === 1,
        ),
    );
    // Another viewer holds the unchanged detail union open. A returning viewer
    // replays an ordinary cached frame, which has no upstream announcement.
    const replay = subscribe(b.ws, "fixture:one", { epoch: "one:one" });
    await until(() => b.frames.some((frame) => frame.id === replay));
    const replayed = b.frames.find((frame) => frame.id === replay)!;
    assert.equal(replayed.type, "frame");
    if (replayed.type !== "frame") throw new Error("Expected replay frame");
    assert.equal(replayed.frame.type, "events");
    assert.equal(replayed.frame.v, 3);
    if (replayed.frame.v !== 3) throw new Error("Expected source capabilities");
    assert.deepEqual(
      replayed.frame.capabilities,
      COMPLETE_WORKSPACE_CAPABILITIES,
    );
    assert.equal(
      calls.get("one"),
      1,
      "Cached replay must not reopen the source",
    );
    // A detail update from a viewer with an older in-flight cursor retains
    // the shared stream and resumes at the server's latest sent watermark.
    subscribe(a.ws, "fixture:one", {
      id: one,
      epoch: "one:one",
      conversations: ["opened-thread"],
    });
    await until(() => calls.get("one") === 2);
    assert.equal(queries.get("one")!.get("epoch"), "one:one");
    assert.equal(queries.get("one")!.get("cursor"), "1");
    assert.equal(queries.get("one")!.get("conversations"), '["opened-thread"]');
    assert.equal(open.get("one")!.size, 1);
    upstream = [...open.get("one")!][0];
    const localCount = a.frames.filter((f) => f.id === local).length;
    upstream.send(JSON.stringify(reset("replacement", 0)));
    for (let cursor = 1; cursor <= 40; cursor++)
      upstream.send(JSON.stringify(event("replacement", cursor)));
    await until(() =>
      a.frames.some(
        (f) => f.type === "frame" && f.id === one && f.frame.cursor === 40,
      ),
    );
    assert.equal(
      a.frames.filter((f) => f.id === local).length,
      localCount,
      "An independent source keeps its own epoch and cursor",
    );
    const lagging = subscribe(b.ws, "fixture:one", { epoch: "replacement" });
    await until(() => b.frames.some((f) => f.id === lagging));
    assert(
      b.frames.some(
        (f) =>
          f.id === lagging &&
          f.type === "frame" &&
          f.frame.type === "reset" &&
          f.frame.cursor === 40,
      ),
      "An evicted replay requests a snapshot at the source watermark",
    );
    generation = "two";
    upstream.send(JSON.stringify(event("replacement", 41)));
    await until(() =>
      a.frames.some((f) => f.id === one && f.type === "closed"),
    );
    assert(
      !a.frames.some(
        (f) => f.id === one && f.type === "frame" && f.frame.cursor === 41,
      ),
      "A queued frame cannot cross a changed grant generation",
    );
    assert.equal(open.get("one")!.size, 0);
    const fresh = subscribe(a.ws, "fixture:one");
    await until(() =>
      a.frames.some((f) => f.id === fresh && f.type === "frame"),
    );
    assert.equal(calls.get("one"), 3);
    for (const ws of browsers) ws.close();
    await until(
      () =>
        [...open.values()].every((group) => group.size === 0) &&
        budget.snapshot().total === 0,
    );
    const resumed = await connect(await pair(host, "Fixture viewer"));
    const resume = subscribe(resumed.ws, "fixture:one", {
      epoch: "one:two",
      cursor: 7,
    });
    await until(() => resumed.frames.some((f) => f.id === resume));
    assert(
      resumed.frames.some(
        (f) =>
          f.type === "frame" &&
          f.id === resume &&
          f.frame.type === "events" &&
          f.frame.epoch === "one:two" &&
          f.frame.cursor === 7,
      ),
      "The first viewer after idle resumes its own source cursor",
    );
  } finally {
    for (const ws of browsers) ws.terminate();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
