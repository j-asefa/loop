import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { until } from "./helpers.js";
import { gitProject } from "./git-project.js";

const root = mkdtempSync(join(tmpdir(), "loop55-mail-worker-"));
const project = join(root, "project");
mkdirSync(project);
gitProject(project);
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = join(root, "data");
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP55_TEST_HARNESS = "codex";
process.env.LOOP55_TEST_FLEET_DISCOVERY_AUDIT = join(root, "discovery.jsonl");
const { db } = await import("../src/server/db.js");
const { createAgent } = await import("../src/server/domain.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { ExecutionProcess } = await import("../src/server/execution-process.js");
const { executionRequest } = await import("../src/server/execution-client.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { fleetMailWorkerService } =
  await import("../src/server/fleet-mail-worker-service.js");
const { fleetAgentAddress } = await import("../src/shared/fleet-mail.js");

test(
  "native discovery crosses the owning execution worker's private IPC without exporting peer credentials",
  { timeout: 60_000 },
  async (t) => {
    const execution = new ExecutionProcess();
    t.after(async () => {
      await execution.close();
      await nativeSessions.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const machineId = "m_" + "a".repeat(64),
      sourceId = "peer:" + machineId,
      remoteAgent = randomUUID();
    const source = {
      machineId,
      sourceId,
      name: "Fixture peer",
      availability: "reachable" as const,
    };
    let reads = 0,
      present = false;
    const observers = new Set<() => void>();
    const service = {
      ...fleetMailWorkerService(OWNER, {
        sources: () => (present ? [source] : []),
        async read(id, query, current) {
          current();
          assert.equal(id, sourceId);
          assert.equal(query.offset, 0);
          reads++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          current();
          return {
            source,
            agents: [
              {
                agentId: fleetAgentAddress({ machineId, agentId: remoteAgent }),
                localAgentId: remoteAgent,
                sourceId,
                executionMachine: source.name,
                name: "remote-fixture",
                runtime: "Codex",
                availability: "available",
              },
            ],
            nextOffset: null,
          };
        },
      }),
      observe(notify: () => void) {
        observers.add(notify);
        return () => {
          observers.delete(notify);
        };
      },
    };
    execution.setFleetMail(service);
    await execution.open();
    const generation = execution.status().generation;
    present = true;
    // A burst must coalesce instead of exhausting reserved lifecycle capacity
    // and replacing a healthy execution owner.
    for (let index = 0; index < 20; index++) {
      source.name = `Fixture peer ${index}`;
      for (const notify of observers) notify();
    }
    await executionRequest("runtime.register", {
      options: {
        harness: "codex",
        executable: resolve("test/harness.mjs"),
        project,
        billing: "existing",
        version: "fixture",
      },
    });
    const connection = db
      .prepare(
        "SELECT id FROM connections WHERE owner_id=? AND json_extract(metadata,'$.loop55Harness')='codex'",
      )
      .get(OWNER) as { id: string };
    assert(connection);
    const agent = createAgent(OWNER, {
      name: "worker-mail-fixture",
      connectionId: connection.id,
      model: "native-default",
    });
    await execution.schedule();
    const run = submit(OWNER, {
      agentId: agent.id,
      input: "Fleet discovery fixture: " + sourceId,
      idempotencyKey: randomUUID(),
    });
    await until(() => {
      const row = db
        .prepare("SELECT state FROM runs WHERE id=?")
        .get(run.id) as { state: string };
      return ["completed", "failed"].includes(row.state);
    }, 30_000);
    const finished = db
      .prepare("SELECT state,error FROM runs WHERE id=?")
      .get(run.id) as { state: string; error: string | null };
    const auditPath = process.env.LOOP55_TEST_FLEET_DISCOVERY_AUDIT!;
    const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";
    assert.equal(finished.state, "completed", finished.error ?? audit);
    assert.equal(reads, 1);
    assert.equal(execution.status().generation, generation);
    assert.match(audit, /remote-fixture/);
    assert.match(audit, /Fixture peer 19/);
    assert(
      audit.includes(fleetAgentAddress({ machineId, agentId: remoteAgent })),
    );
    assert(
      !/credential|publicKey|privateKey|https:|http:|owner_id/.test(audit),
    );
    const native = db
      .prepare("SELECT generation,state FROM native_dispatch WHERE run_id=?")
      .get(run.id) as { generation: string; state: string };
    assert(native.generation);
    assert.equal(native.state, "completed");
    await execution.close();
    assert.equal(observers.size, 0);
  },
);
