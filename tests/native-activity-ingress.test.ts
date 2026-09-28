import type { Live } from "../src/server/native-sessions";
import type { AdapterEvent } from "../src/protocol";
import { Codex } from "../src/adapters/codex";
import { DirectControls } from "../src/adapters/direct-controls";
import { directActivityUpdate } from "../src/activity-bridge";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { NativeOutput } from "../src/server/native-output";
const dir = mkdtempSync(join(tmpdir(), "loop-activity-ingress-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { NativeSessions } = await import("../src/server/native-sessions");
const { activityRoutes } = await import("../src/server/activities");
const { Host } = await import("../src/host");
const { ServerFrame } = await import("../src/protocol");

// The real activity route, authenticated as the conversation owner.
const app = express();
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "owner";
  next();
});
app.use(activityRoutes);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e.status || 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + (server.address() as any).port;
const snapshot = async (conversation: string, after?: number, owner = "owner") => {
  const res = await fetch(
    `${base}/conversations/${conversation}/activities${after ? "?after=" + after : ""}`,
    { headers: { "x-owner": owner } },
  );
  return { status: res.status, body: (await res.json()) as any };
};
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

for (const c of ["conv", "other"])
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','t',0)",
  ).run(c);
db.prepare(
  "INSERT INTO companion_sessions(conversation_id,harness,project,updated_at) VALUES('conv','codex',?,0)",
).run(dir);

function turn(conversation: string, key: string) {
  enqueue("owner", "t", key, { conversation });
  return claim("w")!;
}
// Installs a live session in NativeSessions exactly as session() does: the
// map entry plus the companion_sessions generation written before start().
function start(sessions: InstanceType<typeof NativeSessions>, generation: string, bootstrap: any) {
  const live: Live = {
    binding: {
      conversation_id: "conv",
      harness: "codex",
      native_id: null,
      project: dir,
      model: null,
      instructions: "",
      generation,
      state: "idle",
    },
    adapter: new Codex(
      { harness: "codex", executable: "", version: "fixture", project: dir, billing: "existing" },
      () => {},
    ),
    generation,
    ready: Promise.resolve(),
    bootstrapRun: bootstrap,
    requests: new Map(),
    cancelling: false,
    waiting: false,
    bridgeWaiting: 0,
    items: new NativeOutput(),
    closed: false,
  };
  (sessions as any).live.set("conv", live);
  db.prepare(
    "UPDATE companion_sessions SET generation=?,state='starting' WHERE conversation_id='conv'",
  ).run(generation);
  // The direct adapters' real control publisher, wired to the ingress.
  const controls = new DirectControls("codex", (e: AdapterEvent) => sessions.event(live, e));
  return { live, controls, emit: (e: AdapterEvent) => sessions.event(live, e) };
}
const events = () =>
  db.prepare("SELECT run_id,type,payload FROM events ORDER BY id").all() as {
    run_id: string;
    type: string;
    payload: string;
  }[];
const byKind = (items: any[], kind: string) => items.filter((i) => i.kind === kind);
const option = (id: string, confirmed: string) => ({
  id,
  label: id,
  type: "select" as const,
  choices: [{ value: confirmed, label: confirmed }],
  confirmed,
});
const planEvent = (generation: string, statuses: string[]): AdapterEvent => ({
  type: "activity",
  activity: directActivityUpdate(
    {
      kind: "plan",
      id: "plan-1",
      steps: statuses.map((status, i) => ({ id: "s" + i, text: "Step " + i, status })),
    } as any,
    // The adapter's own notion of generation is never trusted.
    { harness: "codex", generation },
  ),
});

it("persists native activity events through restarts and serves them to reloads without leaking payloads", async () => {
  const bootstrap = turn("conv", "bootstrap");
  let sessions = new NativeSessions();
  const first = start(sessions, "gen-1", bootstrap);
  const before = events().length;

  // Pre-turn: session/load reports catalogs and capabilities before any turn.
  first.controls.publish(
    [option("model", "gpt-a"), option("sandbox", "workspace-write")],
    [{ name: "review", token: "/review", kind: "prompt", description: "Review" }],
  );
  // A replayed tool before a turn has no Loop turn and must not become work.
  first.emit({
    type: "activity",
    activity: {
      v: 1, kind: "tool", id: "replayed", replay: true,
      source: { transport: "native", harness: "codex", origin: "direct" },
      patch: { title: "Edit", status: "completed" },
    },
  });
  let page = (await snapshot("conv")).body;
  expect(byKind(page.items, "tool")).toEqual([]);
  const settings1 = byKind(page.items, "settings")[0];
  expect(settings1).toMatchObject({ run: null });
  expect(settings1.record).toMatchObject({ generation: "gen-1", data: { revision: 1 } });
  expect(settings1.record.data.options.map((o: any) => o.id)).toEqual(["model", "sandbox"]);
  expect(byKind(page.items, "commands")[0].record.data.commands[0]).toMatchObject({ token: "/review" });
  const caps1 = byKind(page.items, "capabilities")[0];
  expect(caps1.key).toBe("capabilities:native:codex");
  expect(caps1.record).toMatchObject({
    generation: "gen-1",
    source: { transport: "native", harness: "codex" },
    capabilities: { plans: { state: "supported" }, settings: { state: "supported" } },
  });

  // Refresh signals are content-free and attributed to the bootstrap run;
  // the raw adapter payload never reaches the events stream.
  const signals = events().slice(before);
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every((e) => e.type === "activity.updated" && e.run_id === bootstrap.id)).toBe(true);
  for (const e of signals) {
    expect(Object.keys(JSON.parse(e.payload)).sort()).toEqual(["key", "kind", "sequence"]);
    expect(e.payload).not.toContain("gpt-a");
  }

  // A turn: adapter-stamped generations are replaced by the server's.
  const run = turn("conv", "turn-1");
  first.live.run = run;
  first.emit(planEvent("adapter-private-id", ["in_progress", "pending"]));
  first.emit(planEvent("adapter-private-id", ["completed", "in_progress"]));
  // Duplicate delivery of an unchanged record writes nothing and signals nothing.
  const signalCount = events().length;
  first.emit({ type: "activity_capabilities", capabilities: first.controls.capabilities });
  expect(events().length).toBe(signalCount);
  first.controls.publish([option("model", "gpt-b"), option("sandbox", "workspace-write")]);
  page = (await snapshot("conv")).body;
  const plans = byKind(page.items, "plan");
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ run: run.id });
  expect(plans[0].record).toMatchObject({ generation: "gen-1", revision: 2 });
  expect(plans[0].record.data.steps.map((s: any) => s.status)).toEqual(["completed", "in_progress"]);
  expect(byKind(page.items, "settings")[0].record.data).toMatchObject({ revision: 2 });
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({ state: "running" });
  const planSignals = events().filter((e) => e.type === "activity.updated" && e.payload.includes('"kind":"plan"'));
  expect(planSignals.map((e) => e.run_id)).toEqual([run.id, run.id]);
  expect(events().some((e) => e.type === "native.event" && e.payload.includes('"activity'))).toBe(false);

  // An oversized display update is dropped without interrupting native work.
  first.emit({
    type: "activity",
    activity: {
      v: 1, kind: "output", id: "huge",
      source: { transport: "native", harness: "codex", origin: "direct" },
      patch: { replace: [{ stream: "stdout", text: "x".repeat(2 * 1024 * 1024) }] },
    },
  });
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({ state: "running" });
  expect(first.live.closed).toBe(false);

  // A run bound to another conversation cannot write into this one.
  const foreign = turn("other", "foreign");
  first.live.run = foreign;
  first.emit(planEvent("x", ["pending"]));
  expect((await snapshot("other")).body.items).toEqual([]);
  expect(byKind((await snapshot("conv")).body.items, "plan")).toHaveLength(1);
  first.live.run = run;

  // Reload: a full snapshot and an incremental page from the cursor agree.
  const cursor = page.cursor;
  first.controls.publish([option("model", "gpt-c"), option("sandbox", "workspace-write")]);
  const delta = (await snapshot("conv", cursor)).body;
  expect(delta.items.map((i: any) => i.kind)).toEqual(["settings"]);
  const full = (await snapshot("conv")).body;
  expect(new Set(full.items.map((i: any) => i.key)).size).toBe(full.items.length);
  expect(byKind(full.items, "settings")[0]).toEqual(delta.items[0]);
  // Another owner cannot read the conversation.
  expect((await snapshot("conv", undefined, "mallory")).status).toBe(404);

  // Process restart: recovery clears the generation. Frames still produced
  // by the old process are stale and quarantined.
  first.live.run = undefined;
  sessions.recover();
  const frozen = JSON.stringify((await snapshot("conv")).body.items);
  first.controls.publish([option("model", "stale")]);
  first.emit(planEvent("x", ["failed", "failed"]));
  expect(JSON.stringify((await snapshot("conv")).body.items)).toBe(frozen);

  // New process, new generation. Producer revisions restart at 1 and the new
  // catalog replaces the old one instead of being rejected as stale.
  sessions = new NativeSessions();
  const second = start(sessions, "gen-2", bootstrap);
  const settingsRevision = byKind(JSON.parse(frozen), "settings")[0].record.revision;
  second.controls.publish([option("model", "gpt-d")], []);
  page = (await snapshot("conv")).body;
  const settings2 = byKind(page.items, "settings")[0];
  expect(settings2.record).toMatchObject({ generation: "gen-2", data: { revision: 1 } });
  expect(settings2.record.data.options.map((o: any) => [o.id, o.confirmed])).toEqual([["model", "gpt-d"]]);
  expect(settings2.record.revision).toBe(settingsRevision + 1);
  expect(byKind(page.items, "commands")[0].record).toMatchObject({ generation: "gen-2", data: { commands: [], revision: 1 } });
  expect(byKind(page.items, "capabilities")[0].record.generation).toBe("gen-2");
  // Completed history from the earlier generation is preserved as history.
  expect(byKind(page.items, "plan")[0].record).toMatchObject({ generation: "gen-1" });
  // The first process's session object is no longer live for this conversation.
  first.controls.publish([option("model", "zombie")]);
  expect(byKind((await snapshot("conv")).body.items, "settings")[0].record.data.options[0].confirmed).toBe("gpt-d");
});

it("never sends activity variants on the v1 host wire used by older clients", () => {
  const host = new Host(join(dir, "host"), {
    harness: "codex",
    project: dir,
    version: "test",
    billing: { mode: "existing", description: "fixture" },
    capabilities: { approvals: true, questions: true, resume: true, liveAttach: false, terminal: false },
  });
  const cursor = host.state.snapshot.cursor;
  const controls = new DirectControls("codex", host.emit);
  controls.publish([option("model", "gpt-a")], [
    { name: "review", token: "/review", kind: "prompt", description: "Review" },
  ]);
  host.emit(planEvent("g", ["pending"]));
  expect(host.state.snapshot.cursor).toBe(cursor);
  expect(host.state.events).toEqual([]);
  host.emit({ type: "status", status: "running" });
  // Every frame the host retains for replay is valid for the v1 union, which
  // no longer admits activity variants.
  for (const frame of host.state.events) expect(ServerFrame.safeParse(frame).success).toBe(true);
  expect(
    ServerFrame.safeParse({ v: 1, epoch: "e", cursor: 1, event: planEvent("g", ["pending"]) }).success,
  ).toBe(false);
});

it("drops activity an adapter files under another transport", async () => {
  const sessions = new NativeSessions();
  const run = turn("conv", "spoof");
  const { live, emit } = start(sessions, "gen-spoof", run);
  live.run = run;
  const before = (await snapshot("conv")).body.items.length;
  for (const transport of ["api", "acp"] as const)
    emit({
      type: "activity",
      activity: {
        v: 1,
        kind: "output",
        id: "spoof-" + transport,
        source: { transport, harness: "codex", origin: "direct" },
        patch: { replace: [{ stream: "stdout", text: "not from " + transport }] },
      },
    });
  expect((await snapshot("conv")).body.items).toHaveLength(before);
  emit({
    type: "activity",
    activity: {
      v: 1,
      kind: "output",
      id: "honest",
      source: { transport: "native", harness: "codex", origin: "direct" },
      patch: { replace: [{ stream: "stdout", text: "ok" }] },
    },
  });
  const outputs = byKind((await snapshot("conv")).body.items, "output");
  expect(outputs.map((o: any) => o.record.id)).toEqual(["honest"]);
});

it("rejects settings writes from stale generations, including replacement during readiness", async () => {
  const sessions = new NativeSessions();
  const current = start(sessions, "controls-new", undefined);
  let calls = 0;
  current.live.adapter.setSetting = async () => {
    calls++;
    return { options: [], revision: 1 };
  };
  await expect(
    sessions.setSetting("conv", "model", "b", 1, "controls-old"),
  ).rejects.toThrow("Native session changed");
  expect(calls).toBe(0);
  let ready!: () => void;
  current.live.ready = new Promise<void>((r) => {
    ready = r;
  });
  const writing = sessions.setSetting("conv", "model", "b", 1, "controls-new");
  start(sessions, "controls-replacement", undefined);
  ready();
  await expect(writing).rejects.toThrow("Native session changed");
  expect(calls).toBe(0);
});

it("does not return old adapter controls or confirm a write after the binding changes", async () => {
  const sessions = new NativeSessions();
  const current = start(sessions, "controls-before", undefined);
  current.live.adapter.setSetting = async () => {
    db.prepare(
      "UPDATE companion_sessions SET generation='controls-after' WHERE conversation_id='conv'",
    ).run();
    return { options: [], revision: 2 };
  };
  await expect(
    sessions.setSetting("conv", "model", "b", 1, "controls-before"),
  ).rejects.toThrow("Native session changed");
  expect(sessions.controls("conv")).toMatchObject({
    generation: "controls-after",
    state: "disconnected",
    settings: { options: [] },
    capabilities: { settings: { state: "undiscovered" } },
  });
});
