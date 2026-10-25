import { parseConnection } from "../src/server/row-schemas.js";
import { inProcessExecution } from "./in-process-execution.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gitProject } from "./git-project.js";
import { until } from "./helpers.js";

const directory = mkdtempSync(join(tmpdir(), "loop-authority-"));
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_DATA_DIR = join(directory, "data");
process.env.LOOP_TEST_HARNESS = "claude";
process.env.LOOP_TEST_PROBE_AUDIT = join(directory, "probes");
process.env.LOOP_TEST_PROBE_FAIL_FILE = join(directory, "refuse-probe");
process.env.LOOP_TEST_AUDIT = join(directory, "prompts");
process.env.LOOP_TEST_SETTING_AUDIT = join(directory, "settings");
process.env.LOOP_TEST_SETTING_DROP = "1";
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");
const { executionAuthority } =
  await import("../src/server/execution-authority.js");
const { executionClient, setExecutionTransport, ExecutionClient } =
  await import("../src/server/execution-client.js");
const { EXECUTION_REQUEST_BYTES } =
  await import("../src/shared/execution-authority.js");

test(
  "paired execution boundary preserves command identity across lost replies and rejects stale authority traffic",
  { timeout: 60_000 },
  async (t) => {
    const project = join(directory, "project");
    mkdirSync(project);
    gitProject(project);
    const host = new WorkspaceHost(directory, {
      harness: "claude",
      executable: resolve("test/harness.mjs"),
      project,
      version: "fixture",
      billing: "existing",
    }, inProcessExecution);
    t.after(async () => {
      await host.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await host.start({
      harness: "claude",
      executable: resolve("test/harness.mjs"),
      project,
      version: "fixture",
      billing: "existing",
    });
    const origin = host.origin;
    const pair = await fetch(origin + "/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: new URLSearchParams(new URL(host.pair().url).hash.slice(1)).get(
          "pair",
        ),
        name: "authority fixture",
      }),
    });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await fetch(origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json());
    const request = (path: string, body?: object, method?: string) =>
      fetch(origin + "/api" + path, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          cookie,
          Origin: origin,
          "x-loop-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const api = async (path: string, body?: object, method?: string) => {
      const response = await request(path, body, method),
        data = await response.json();
      assert(
        response.ok,
        JSON.stringify({ path, status: response.status, data }),
      );
      return data;
    };
    const normal = () =>
      setExecutionTransport({
        status: () => executionAuthority.status(),
        send: (message) => executionAuthority.request(message),
      });
    const bootstrap = await api("/bootstrap");
    const projectId = bootstrap.folders.find(
      (folder: { path?: string }) => folder.path === project,
    ).id;
    const countProbes = () =>
      readFileSync(process.env.LOOP_TEST_PROBE_AUDIT!, "utf8")
        .trim()
        .split("\n").length;

    await t.test(
      "lost enablement replies reconcile without probing twice",
      async () => {
        const before = countProbes();
        const input = {
          projectId,
          billing: "existing",
          commandId: randomUUID(),
        };
        let drop = true;
        setExecutionTransport({
          status: () => executionAuthority.status(),
          send: async (message) => {
            const reply = await executionAuthority.request(message);
            if (message.method === "runtime.enable" && drop) {
              drop = false;
              throw new Error("fixture reply lost after commit");
            }
            return reply;
          },
        });
        assert.equal(
          (await request("/workspace/runtimes/claude/enable", input)).status,
          503,
        );
        assert.equal(countProbes(), before + 1);
        assert.equal(
          (await api("/workspace/runtimes/claude/enable", input)).name,
          "claude",
        );
        assert.equal(countProbes(), before + 1);
        assert.equal(
          (
            await request("/workspace/runtimes/claude/enable", {
              ...input,
              billing: "subscription",
            })
          ).status,
          409,
        );
        normal();
      },
    );
    await t.test("concurrent retries share an uncertain execution outcome", async () => {
      const { nativeSessions } = await import("../src/server/native-sessions.js");
      const enable = nativeSessions.enable;
      let entered = false, calls = 0, release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const before = countProbes();
      nativeSessions.enable = async function (options) {
        await enable.call(this, options);
        entered = true;
        await held;
        throw new Error("fixture confirmation lost after native verification");
      };
      setExecutionTransport({
        status: () => executionAuthority.status(),
        send(message) { calls++; return executionAuthority.request(message); },
      });
      const input = { projectId, billing: "existing", commandId: randomUUID() };
      try {
        const first = request("/workspace/runtimes/claude/enable", input);
        await until(() => entered);
        const duplicate = request("/workspace/runtimes/claude/enable", input);
        await until(() => calls === 2);
        release();
        for (const response of await Promise.all([first, duplicate])) {
          assert.equal(response.status, 422);
          assert.equal((await response.json()).executionOutcome, "unknown");
        }
        assert.equal(countProbes(), before + 1);
        assert.equal((db.prepare("SELECT state FROM execution_commands WHERE command_id=?").get(input.commandId) as any).state, "unknown");
      } finally {
        release();
        nativeSessions.enable = enable;
        normal();
      }
    });
    await t.test(
      "a pre-execution upgrade refusal leaves the enablement command retryable",
      async () => {
        const { harnessUpgrades } =
          await import("../src/server/harness-upgrades.js");
        const input = {
          projectId,
          billing: "existing",
          commandId: randomUUID(),
        };
        const before = countProbes();
        const release = harnessUpgrades.reserve("claude");
        try {
          assert.equal(
            (await request("/workspace/runtimes/claude/enable", input)).status,
            409,
          );
        } finally {
          release();
        }
        assert.equal(countProbes(), before);
        assert.equal(
          (await api("/workspace/runtimes/claude/enable", input)).name,
          "claude",
        );
        assert.equal(countProbes(), before + 1);
      },
    );
    await t.test(
      "failed runtime verification can be retried after repairing native setup",
      async () => {
        const input = {
          projectId,
          billing: "existing",
          commandId: randomUUID(),
        };
        const before = countProbes();
        writeFileSync(
          process.env.LOOP_TEST_PROBE_FAIL_FILE!,
          "fixture startup refuses before any task prompt",
        );
        try {
          assert.equal(
            (await request("/workspace/runtimes/claude/enable", input)).status,
            422,
          );
        } finally {
          unlinkSync(process.env.LOOP_TEST_PROBE_FAIL_FILE!);
        }
        assert.equal(countProbes(), before + 1);
        assert.equal(
          (await api("/workspace/runtimes/claude/enable", input)).name,
          "claude",
        );
        assert.equal(countProbes(), before + 2);
        assert.equal(existsSync(process.env.LOOP_TEST_AUDIT!), false);
      },
    );
    await t.test(
      "restoring a missing project permits the same enablement command",
      async () => {
        const input = {
          projectId,
          billing: "existing",
          commandId: randomUUID(),
        };
        const before = countProbes();
        renameSync(project, project + ".away");
        try {
          assert.equal(
            (await request("/workspace/runtimes/claude/enable", input)).status,
            422,
          );
          assert.equal(countProbes(), before);
        } finally {
          renameSync(project + ".away", project);
        }
        assert.equal(
          (await api("/workspace/runtimes/claude/enable", input)).name,
          "claude",
        );
        assert.equal(countProbes(), before + 1);
      },
    );
    await t.test(
      "model and native status refreshes do not create command receipts",
      async () => {
        const count = () =>
          (
            db.prepare("SELECT count(*) n FROM execution_commands").get() as {
              n: number;
            }
          ).n;
        const before = count();
        const { runtimeAction } =
          await import("../src/server/subscriptions.js");
        for (let i = 0; i < 3; i++) {
          assert(
            Array.isArray(
              (await api("/connections/native-claude/models")).models,
            ),
          );
          assert.equal(
            (await api("/connections/native-claude/refresh", {})).name,
            "claude",
          );
          const connection = parseConnection(db
            .prepare("SELECT * FROM connections WHERE id='native-claude'")
            .get());
          assert.equal(
            (await runtimeAction(connection, "status")).name,
            "claude",
          );
        }
        assert.equal(count(), before);
      },
    );
    await t.test(
      "receipt compaction bounds response payloads without replaying old or uncertain commands",
      async () => {
        const input = { name: "claude", projectId, billing: "existing" };
        const digest = createHash("sha256")
          .update(JSON.stringify(["runtime.enable", input]))
          .digest("hex");
        const oldCommand = randomUUID(),
          unknownCommand = randomUUID();
        const insert = db.prepare(
          "INSERT INTO execution_commands VALUES(?,?, 'runtime.enable',?,?, ?,?,1,?)",
        );
        insert.run(
          "local-workspace",
          oldCommand,
          digest,
          executionAuthority.generation,
          "completed",
          "{}",
          1,
        );
        insert.run(
          "local-workspace",
          unknownCommand,
          digest,
          executionAuthority.generation,
          "unknown",
          null,
          1,
        );
        const otherOwner = randomUUID();
        insert.run(
          "other-owner",
          otherOwner,
          digest,
          executionAuthority.generation,
          "completed",
          '{"retained":true}',
          1,
        );
        for (let i = 0; i < 80; i++)
          insert.run(
            "local-workspace",
            randomUUID(),
            digest,
            executionAuthority.generation,
            "completed",
            JSON.stringify({ padding: "x".repeat(i >= 70 ? 1024 * 1024 : 8) }),
            i + 2,
          );
        await api("/workspace/runtimes/claude/enable", {
          projectId,
          billing: "existing",
          commandId: randomUUID(),
        });
        const cached = db
          .prepare(
            "SELECT count(*) n,coalesce(sum(length(CAST(result AS BLOB))),0) bytes FROM execution_commands WHERE owner_id='local-workspace' AND result IS NOT NULL",
          )
          .get() as { n: number; bytes: number };
        assert(
          cached.n <= 64 && cached.bytes <= 4 * 1024 * 1024,
          JSON.stringify(cached),
        );
        const before = countProbes();
        const expired = await request("/workspace/runtimes/claude/enable", {
          projectId,
          billing: "existing",
          commandId: oldCommand,
        });
        assert.equal(expired.status, 409);
        const expiredBody = await expired.json();
        assert.match(
          expiredBody.error,
          /completed.*response expired.*not replayed/i,
        );
        assert.equal(expiredBody.executionOutcome, "completed");
        const unknown = await request("/workspace/runtimes/claude/enable", {
          projectId,
          billing: "existing",
          commandId: unknownCommand,
        });
        assert.equal(unknown.status, 409);
        const unknownBody = await unknown.json();
        assert.match(unknownBody.error, /unknown.*not replayed/i);
        assert.equal(unknownBody.executionOutcome, "unknown");
        assert.equal(countProbes(), before);
        assert.deepEqual(
          db
            .prepare(
              "SELECT state,result FROM execution_commands WHERE command_id=?",
            )
            .get(oldCommand),
          { state: "completed", result: null },
        );
        assert.deepEqual(
          db
            .prepare(
              "SELECT state,result FROM execution_commands WHERE command_id=?",
            )
            .get(unknownCommand),
          { state: "unknown", result: null },
        );
        assert.deepEqual(
          db
            .prepare("SELECT result FROM execution_commands WHERE command_id=?")
            .get(otherOwner),
          { result: '{"retained":true}' },
        );
      },
    );
    const agent = await api("/agents", {
      name: "authority-fixture",
      connectionId: "native-claude",
      model: "native-default",
      folderId: projectId,
      instructions: "Fixture",
    });
    const run = await api("/runs", {
      agentId: agent.id,
      input: "fixture",
      idempotencyKey: randomUUID(),
    });
    await until(
      () =>
        (
          db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
            state: string;
          }
        ).state === "completed",
    );
    const path = `/conversations/${run.conversation_id}/settings`;
    let controls = await api(path);

    await t.test(
      "a busy native session refuses before reserving a setting effect",
      async () => {
        const active = await api("/runs", {
          agentId: agent.id,
          conversationId: run.conversation_id,
          input: "wait",
          idempotencyKey: randomUUID(),
        });
        await until(
          () =>
            (
              db
                .prepare("SELECT state FROM native_dispatch WHERE run_id=?")
                .get(active.id) as { state?: string } | undefined
            )?.state === "accepted",
        );
        controls = await api(path);
        const input = {
          value: "default",
          revision: controls.settings.revision,
          generation: controls.generation,
          commandId: randomUUID(),
        };
        const refused = await request(path + "/mode", input, "PATCH");
        assert.equal(refused.status, 409);
        assert.match((await refused.json()).error, /Wait for the native turn/);
        const follow = await api("/runs", {
          agentId: agent.id,
          conversationId: run.conversation_id,
          input: "finish the wait",
          idempotencyKey: randomUUID(),
        });
        assert(follow.steeringId);
        await until(
          () =>
            (
              db
                .prepare("SELECT state FROM runs WHERE id=?")
                .get(active.id) as { state: string }
            ).state === "completed",
        );
        assert.equal((await api(path)).generation, input.generation);
        controls = await api(path + "/mode", input, "PATCH");
        assert.equal(
          readFileSync(process.env.LOOP_TEST_SETTING_AUDIT!, "utf8"),
          "default\n",
        );
      },
    );

    await t.test(
      "lost setting replies return a durable result without a second protocol command",
      async () => {
        const input = {
          value: "acceptEdits",
          revision: controls.settings.revision,
          generation: controls.generation,
          commandId: randomUUID(),
        };
        let drop = true;
        setExecutionTransport({
          status: () => executionAuthority.status(),
          send: async (message) => {
            const reply = await executionAuthority.request(message);
            if (message.method === "native.setting" && drop) {
              drop = false;
              throw new Error("fixture setting reply lost");
            }
            return reply;
          },
        });
        assert.equal(
          (await request(path + "/mode", input, "PATCH")).status,
          503,
        );
        controls = await api(path + "/mode", input, "PATCH");
        assert.equal(
          controls.settings.options.find(
            (option: { id: string }) => option.id === "mode",
          ).confirmed,
          "acceptEdits",
        );
        assert.equal(
          readFileSync(process.env.LOOP_TEST_SETTING_AUDIT!, "utf8"),
          "default\nacceptEdits\n",
        );
        normal();
      },
    );
    await t.test(
      "stale responses and queued requests cannot survive a disconnect",
      async () => {
        let release!: () => void,
          entered = false;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        setExecutionTransport({
          status: () => executionAuthority.status(),
          send: async (message) => {
            const reply = await executionAuthority.request(message);
            entered = true;
            await held;
            return reply;
          },
        });
        const response = request(path);
        await until(() => entered);
        normal();
        assert.equal((await response).status, 503);
        release();
        assert.equal((await api(path)).generation, controls.generation);
        const client = new ExecutionClient();
        let sent = 0;
        client.connect({
          status: () => executionAuthority.status(),
          send: (message) => {
            sent++;
            return executionAuthority.request(message);
          },
        });
        const pending = client.request("runtime.status", {});
        client.disconnect();
        await assert.rejects(pending, /disconnected/);
        assert.equal(sent, 0);
      },
    );
    await t.test(
      "authority validates ownership, generation and byte bounds before execution",
      async () => {
        const base = {
          v: 1,
          requestId: randomUUID(),
          generation: executionAuthority.generation,
          owner: "local-workspace",
          method: "runtime.status",
          input: {},
        };
        const foreign = await executionAuthority.request({
          ...base,
          owner: "other-owner",
        });
        assert(!foreign.ok && foreign.error.status === 403);
        const stale = await executionAuthority.request({
          ...base,
          generation: randomUUID(),
        });
        assert(!stale.ok && stale.error.status === 409);
        await assert.rejects(
          executionAuthority.request({
            ...base,
            input: { padding: "x".repeat(EXECUTION_REQUEST_BYTES) },
          }),
          /size limit/,
        );
        const commandId = randomUUID();
        const input = {
          conversationId: run.conversation_id,
          setting: "mode",
          value: "default",
          revision: controls.settings.revision,
          generation: controls.generation,
        };
        const digest = createHash("sha256")
          .update(JSON.stringify(["native.setting", input]))
          .digest("hex");
        db.prepare(
          "INSERT INTO execution_commands VALUES(?,?,?,?,?,'started',NULL,1,1)",
        ).run(
          "local-workspace",
          commandId,
          "native.setting",
          digest,
          randomUUID(),
        );
        const retry = await request(
          path + "/mode",
          {
            value: input.value,
            revision: input.revision,
            generation: input.generation,
            commandId,
          },
          "PATCH",
        );
        assert.equal(retry.status, 409);
        assert.match((await retry.json()).error, /unknown.*not replayed/i);
        assert.equal(
          readFileSync(process.env.LOOP_TEST_SETTING_AUDIT!, "utf8"),
          "default\nacceptEdits\n",
        );
      },
    );
    await t.test(
      "uncertain native setting transport is never answered twice",
      async () => {
        const input = {
          value: "plan",
          revision: controls.settings.revision,
          generation: controls.generation,
          commandId: randomUUID(),
        };
        assert.equal(
          (await request(path + "/mode", input, "PATCH")).status,
          409,
        );
        const retry = await request(path + "/mode", input, "PATCH");
        assert.equal(retry.status, 409);
        assert.match((await retry.json()).error, /unknown.*not replayed/i);
        assert.equal(
          readFileSync(process.env.LOOP_TEST_SETTING_AUDIT!, "utf8"),
          "default\nacceptEdits\nplan\n",
        );
      },
    );
    assert.equal(executionClient.connected, true);
  },
);
