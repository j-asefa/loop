process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  chmod,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const dir = await realpath(await mkdtemp(join(tmpdir(), "loop-workspace-")));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_TEST_HARNESS = "codex";
process.env.LOOP_TEST_AUDIT = join(dir, "audit");
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { nativeSessions, OWNER } =
  await import("../src/server/native-sessions.js");
const { db } = await import("../src/server/db.js");
const { control } = await import("../src/host-control.js");
import { until } from "./helpers.js";
test("workspace: one pairing, three concurrent native conversations, isolated decisions, tools, follow-up, WSS replay, recovery", async (t) => {
  const projectA = join(dir, "a"),
    projectB = join(dir, "b");
  await mkdir(projectA);
  await mkdir(projectB);
  process.env.LOOP_TEST_HISTORY_PROJECT = projectB;
  const executable = resolve("test/harness.mjs");
  await chmod(executable, 0o755);
  const options = {
    harness: "codex" as const,
    executable,
    project: projectA,
    version: "fixture",
    billing: "existing" as const,
  };
  const host = new WorkspaceHost(dir, options);
  const sockets: WebSocket[] = [];
  try {
    await host.start(options);
    const pair = host.pair(),
      secret = new URLSearchParams(new URL(pair.url).hash.slice(1)).get("pair");
    assert.deepEqual(
      await fetch(host.origin + "/api/capabilities").then((r) => r.json()),
      {
        profile: "companion",
        nativeHarnesses: true,
        pairedDevices: true,
        runtimeHosts: false,
        localProjects: true,
      },
    );
    assert.equal((await fetch(host.origin + "/api/bootstrap")).status, 401);
    const redemption = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ secret, name: "fixture phone" }),
    });
    assert.equal(redemption.status, 200);
    const cookie = redemption.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await fetch(host.origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json())) as any;
    const raw = (path: string, body?: any, method?: string) =>
      fetch(host.origin + "/api" + path, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          cookie,
          Origin: host.origin,
          "x-loop-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const api = async (path: string, body?: any, method?: string) => {
      const r = await raw(path, body, method),
        data = await r.json();
      assert(r.ok, JSON.stringify({ path, status: r.status, data }));
      return data as any;
    };
    await t.test("pairing enforces CSRF and profile capabilities", async () => {
      assert.equal(
        (
          await fetch(host.origin + "/api/agents", {
            method: "POST",
            headers: {
              cookie,
              Origin: host.origin,
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        ).status,
        403,
      );
    });
    const bootstrap = await api("/bootstrap");
    const a = bootstrap.folders.find((f: any) => f.path === projectA);
    assert(a, "Bootstrap includes the canonical project directory");
    const b = await api("/workspace/projects", {
      path: projectB,
      name: "Project B",
    });
    const agents: any[] = [];
    for (let i = 0; i < 3; i++)
      agents.push(
        await api("/agents", {
          name: "fixture-" + i,
          connectionId: "native-codex",
          model: "native-default",
          instructions: "Instruction " + i,
          folderId: i === 2 ? b.id : a.id,
        }),
      );
    const frames: any[] = [];
    const ws = new WebSocket(host.origin.replace("http", "ws") + "/ws", {
      headers: { Cookie: cookie, Origin: host.origin },
    });
    sockets.push(ws);
    ws.on("message", (m) => frames.push(JSON.parse(m.toString())));
    await until(() => frames.length > 0);
    assert.equal(frames[0].type, "reset");
    const { Codex } = await import("../src/adapters/codex.js");
    const originalStart = Codex.prototype.start;
    let releaseStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    let starting = 0;
    Codex.prototype.start = async function () {
      starting++;
      await startup;
      return originalStart.call(this);
    };
    let prompts: any[] = [];
    const state = (id: string) =>
      (db.prepare("SELECT state FROM runs WHERE id=?").get(id) as any).state;
    try {
      prompts = await Promise.all(
        agents.map((agent: any, i) =>
          api("/runs", {
            agentId: agent.id,
            input: i === 0 ? "approve" : "wait",
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      await t.test(
        "pause is rejected while native startup has no dispatch record",
        async () => {
          await until(() => starting === 3);
          assert.equal(
            (db.prepare("SELECT count(*) n FROM native_dispatch").get() as any)
              .n,
            0,
          );
          assert.equal(
            (await raw("/runs/" + prompts[1].id + "/pause", {})).status,
            409,
          );
          assert.equal(state(prompts[1].id), "running");
          assert.equal((await raw("/runtime-hosts")).status, 404);
        },
      );
    } finally {
      releaseStartup();
      Codex.prototype.start = originalStart;
    }
    await until(
      () =>
        state(prompts[0].id) === "awaiting_approval" &&
        state(prompts[1].id) === "running" &&
        state(prompts[2].id) === "running" &&
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM native_sessions WHERE native_id IS NOT NULL",
            )
            .get() as { n: number }
        ).n === 3,
    );
    const bindings = db.prepare("SELECT * FROM native_sessions").all() as any[];
    assert.equal(new Set(bindings.map((b) => b.native_id)).size, 3);
    assert.deepEqual(
      bindings.map((b) => b.project).sort(),
      [projectA, projectA, projectB].sort(),
    );
    await t.test("native decisions are isolated and idempotent", async () => {
      const decisions = await api("/native/decisions");
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].conversation_id, prompts[0].conversation_id);
      const decision = {
        commandId: randomUUID(),
        answer: { choice: "decline" },
      };
      await api("/native/decisions/" + decisions[0].id, decision);
      await api("/native/decisions/" + decisions[0].id, decision);
      assert.equal(
        (
          await raw("/native/decisions/" + decisions[0].id, {
            ...decision,
            answer: { choice: "accept" },
          })
        ).status,
        409,
      );
      await until(() => state(prompts[0].id) === "completed");
      assert.equal(state(prompts[1].id), "running");
    });
    await t.test(
      "follow-up retains the native session and rejects conflicting retries",
      async () => {
        const followup = {
          agentId: agents[0].id,
          conversationId: prompts[0].conversation_id,
          input: "follow-up",
          idempotencyKey: randomUUID(),
        };
        const follow = await api("/runs", followup);
        assert.equal((await api("/runs", followup)).id, follow.id);
        assert.equal(
          (await raw("/runs", { ...followup, input: "different" })).status,
          409,
        );
        await until(() => state(follow.id) === "completed");
        assert.equal(
          (
            db
              .prepare(
                "SELECT native_id FROM native_sessions WHERE conversation_id=?",
              )
              .get(follow.conversation_id) as any
          ).native_id,
          bindings.find((b) => b.conversation_id === follow.conversation_id)
            .native_id,
        );
      },
    );
    await t.test("workspace tools and approvals remain isolated", async () => {
      const bind = bindings.find(
        (b) => b.conversation_id === prompts[2].conversation_id,
      );
      const endpoint = nativeSessions.tools!(
        bind.conversation_id,
        bind.generation,
      );
      assert.equal(
        (await fetch(endpoint.url, { method: "POST", body: "{}" })).status,
        403,
      );
      const client = new Client({ name: "fixture-native", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: {
            headers: { Authorization: "Bearer " + endpoint.token },
          },
        }),
      );
      const { installConfig } = await import("../src/server/mcp/install.js");
      await installConfig(OWNER, {
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [resolve("test/mcp-fixture.mjs")],
            env: {},
          },
        },
      });
      const tools = await client.listTools();
      assert(tools.tools.some((t) => t.name === "loop_diagram"));
      const diagram = await client.callTool({
        name: "loop_diagram",
        arguments: {
          title: "Fixture flow",
          source: "flowchart TD\n A[Start] --> B[Done]",
        },
      });
      assert(!diagram.isError);
      const mcpTool = tools.tools.find((t) => t.name.startsWith("loop_mcp_"))!;
      const called = client.callTool({
        name: mcpTool.name,
        arguments: { text: "approval isolated" },
      });
      await until(() => state(prompts[2].id) === "awaiting_approval");
      const approval = db
        .prepare("SELECT id FROM approvals WHERE run_id=? AND state='pending'")
        .get(prompts[2].id) as any;
      const { decide } = await import("../src/server/approvals.js");
      decide(OWNER, approval.id, "approve");
      const toolResult = await called;
      assert.match(JSON.stringify(toolResult), /MCP result approval isolated/);
      assert.equal(state(prompts[1].id), "running");
      assert.equal(
        (
          db
            .prepare("SELECT count(*) n FROM artifacts WHERE kind='diagram'")
            .get() as any
        ).n,
        1,
      );
      await client.close();
    });
    await t.test("cancellation and searchable artifacts", async () => {
      assert.equal(
        (await raw("/runs/" + prompts[1].id + "/pause", {})).status,
        409,
      );
      await api("/runs/" + prompts[1].id + "/cancel", {});
      await until(() => state(prompts[1].id) === "cancelled");
      assert.equal(state(prompts[2].id), "running");
      const saved = await api("/artifacts", {
        title: "Workspace searchable fixture",
        content: "unique-native-workspace-evidence",
        kind: "markdown",
      });
      assert(saved.id);
      assert(
        (await api("/artifacts")).items.some((x: any) => x.id === saved.id),
      );
      assert(
        (await api("/search?q=unique-native-workspace-evidence")).items
          ?.length ||
          (await api("/search?q=unique-native-workspace-evidence")).length,
      );
    });
    await t.test("host reuse and WebSocket replay", async () => {
      const status = await control(dir, "status");
      assert.equal(status.agents, 3);
      await control(dir, "enable", options);
      assert.equal((await control(dir, "status")).url, status.url);
      await until(() => frames.some((m) => m.type === "events"));
      ws.close();
      const last = frames.at(-1);
      const replay: any[] = [];
      const reconnected = new WebSocket(
        host.origin.replace("http", "ws") + `/ws?epoch=${last.epoch}&cursor=0`,
        { headers: { Cookie: cookie, Origin: host.origin } },
      );
      sockets.push(reconnected);
      reconnected.on("message", (m) => replay.push(JSON.parse(m.toString())));
      await until(() => replay.length > 0);
      assert.equal(replay[0].type, "events");
    });
    await t.test("native history discovery and idempotent fork", async () => {
      const catalog = await api("/native/history?discover=1");
      assert.equal(catalog.external[0].project, projectB);
      const history = await api("/native/history/" + catalog.external[0].id);
      assert.equal(history.items[0].text, "Native saved context");
      const forkCommand = { commandId: randomUUID() };
      const fork = await api(
        "/native/history/" + catalog.external[0].id + "/fork",
        forkCommand,
      );
      assert.equal(
        (
          await api(
            "/native/history/" + catalog.external[0].id + "/fork",
            forkCommand,
          )
        ).id,
        fork.id,
      );
    });
    await t.test(
      "legacy migration preserves source files and is idempotent",
      async () => {
        const legacyRoot = join(dir, "legacy-root"),
          legacyPath = join(legacyRoot, "projects", "a".repeat(20));
        await mkdir(legacyPath, { recursive: true });
        const legacy = JSON.stringify({
          snapshot: {
            harness: "codex",
            nativeSession: "legacy-thread",
            project: projectA,
            version: "fixture",
            billing: { mode: "existing" },
            items: [
              {
                id: "old",
                kind: "assistant",
                text: "Legacy content preserved",
              },
            ],
          },
        });
        await writeFile(join(legacyPath, "session.json"), legacy);
        const { migrateLegacy } = await import("../src/server/migration.js");
        await migrateLegacy(legacyRoot);
        await migrateLegacy(legacyRoot);
        assert.equal(
          (db.prepare("SELECT count(*) n FROM legacy_imports").get() as any).n,
          1,
        );
        assert.equal(
          await readFile(join(legacyPath, "session.json"), "utf8"),
          legacy,
        );
        assert.equal((await readdir(join(dir, "legacy-backups"))).length, 1);
      },
    );
    await t.test(
      "enabling another harness and recovery never replays native prompts",
      async () => {
        process.env.LOOP_TEST_HARNESS = "pi";
        await control(dir, "enable", { ...options, harness: "pi" });
        delete process.env.LOOP_TEST_HARNESS;
        assert.equal((await api("/bootstrap")).connections.length, 2);
        const auditBefore = (
          await readFile(process.env.LOOP_TEST_AUDIT!, "utf8")
        )
          .trim()
          .split("\n").length;
        await host.close();
        assert.equal(state(prompts[2].id), "interrupted");
        nativeSessions.recover();
        assert.equal(
          (await readFile(process.env.LOOP_TEST_AUDIT!, "utf8"))
            .trim()
            .split("\n").length,
          auditBefore,
        );
        assert.equal(
          (
            db
              .prepare(
                "SELECT count(*) n FROM native_decisions WHERE state='pending'",
              )
              .get() as any
          ).n,
          0,
        );
      },
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await host.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
