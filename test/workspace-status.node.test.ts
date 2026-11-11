import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const directory = mkdtempSync(join(tmpdir(), "loop-workspace-status-"));
process.env.LOOP_DATA_DIR = directory;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db, changes } = await import("../src/server/db.js");
const { OWNER } = await import("../src/server/workspace-identity.js");
const { RunState } = await import("../src/shared/run-state.js");
const { enqueue } = await import("../src/server/queue.js");
const connections = await import("../src/server/sql/connections.js");
const { nativeSessions } = await import("../src/server/native-sessions.js");
const { closeExecution } = await import("../src/server/execution-client.js");

test("workspace status counts only its owner and preserves executing-run and retired-agent semantics", async () => {
  const host = new WorkspaceHost(
    directory,
    {
      harness: "codex",
      executable: process.execPath,
      project: directory,
      version: "fixture",
      billing: "existing",
    },
    { open: async () => {}, schedule: async () => {}, close: async () => {} },
  );
  try {
    const status = () =>
      host.gateway.workspace.status() as {
        agents: number;
        activeRuns: { n: number };
        executionReady: boolean;
      };
    assert.equal(status().agents, 0);
    assert.deepEqual(status().activeRuns, { n: 0 });
    for (const owner of ["foreign", OWNER]) {
      for (const state of RunState.options) {
        const run = enqueue(owner, "Fixture", randomUUID());
        db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, run.id);
      }
      for (const retired of [false, true]) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at,retired_at) VALUES(?,?,?,?,'openai','fixture','','loop',1,?)",
        ).run(id, owner, id, id, retired ? 2 : null);
      }
      assert.equal(status().agents, owner === OWNER ? 2 : 0);
      assert.deepEqual(status().activeRuns, { n: owner === OWNER ? 3 : 0 });
    }
    const connection = randomUUID();
    db.prepare(
      "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,1)",
    ).run(connection, "foreign", JSON.stringify({ loopHarness: "codex" }));
    assert.equal(connections.connectedHarnessExists(db, OWNER), false);
    assert.equal(connections.connectedHarnessExists(db, "foreign"), true);
    db.prepare(
      "UPDATE connections SET owner_id=?,status='disconnected' WHERE id=?",
    ).run(OWNER, connection);
    assert.equal(connections.connectedHarnessExists(db, OWNER), false);
    db.prepare(
      "UPDATE connections SET status='connected',metadata='{}' WHERE id=?",
    ).run(connection);
    assert.equal(connections.connectedHarnessExists(db, OWNER), false);
    db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
      JSON.stringify({ loopHarness: "codex" }),
      connection,
    );
    assert.equal(connections.connectedHarnessExists(db, OWNER), true);
    assert.equal(
      status().executionReady,
      false,
      "a connected harness record alone does not make the worker ready",
    );
  } finally {
    await host.close();
    await nativeSessions.close();
    await closeExecution();
    changes.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
