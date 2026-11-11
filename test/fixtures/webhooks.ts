import { randomUUID } from "node:crypto";
import { db, now } from "../../src/server/db.js";
import { enqueue, transition } from "../../src/server/queue.js";
import { requestApproval } from "../../src/server/approvals.js";
import { enqueueStoppedWebhooks } from "../../src/server/webhook-outbox.js";
import { claimWebhooks, deliverWebhooks } from "../../src/server/webhooks.js";
import { nativeSessions } from "../../src/server/native-sessions.js";
import { RunState } from "../../src/shared/run-state.js";
import { startWorker } from "../../src/server/worker.js";
import { config, setWorkspaceUrl } from "../../src/server/config.js";

let stopWorker: ReturnType<typeof startWorker> | undefined;

export async function webhookFixture(
  action: string,
  input: Record<string, unknown>,
) {
  if (action === "start-worker") {
    stopWorker = startWorker();
    return;
  }
  if (action === "stop-worker") {
    await stopWorker?.();
    stopWorker = undefined;
    return;
  }
  if (action === "deliver") return deliverWebhooks();
  if (action === "claim") return claimWebhooks();
  if (action === "recover-native") return nativeSessions.recover();
  if (action === "reproject") {
    return db
      .transaction(() => {
        enqueueStoppedWebhooks(db, Number(input.event));
        enqueueStoppedWebhooks(db, Number(input.event));
      })
      .immediate();
  }
  if (action === "transition") {
    const owner = String(input.owner);
    const run = input.run
      ? { id: String(input.run), owner_id: owner }
      : enqueue(owner, "Webhook fixture", randomUUID(), {
          agent: String(input.agent),
          conversation: String(input.conversation),
          kind: "diagnostic",
        });
    // Seed the execution state; the stop itself always crosses transition().
    if (input.from)
      db.prepare("UPDATE runs SET state=? WHERE id=?").run(
        RunState.parse(input.from),
        run.id,
      );
    const full = db
      .prepare("SELECT * FROM runs WHERE id=?")
      .get(run.id) as ReturnType<typeof enqueue>;
    if (input.needs === "approval") requestApproval(full, { tool: "fixture" });
    if (input.needs === "answer")
      db.prepare(
        `INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at)
      VALUES(?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        run.id,
        String(input.conversation),
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          kind: "question",
          secret: "never-in-a-webhook",
          title: "Fixture",
        }),
        now(),
      );
    db.prepare("UPDATE runs SET result=? WHERE id=?").run(
      "**Plain** result " + "x".repeat(250),
      run.id,
    );
    let changed = false;
    const publicUrl = config.url;
    try {
      if (input.publicUrl) setWorkspaceUrl(String(input.publicUrl));
      db.transaction(() => {
        changed = transition(run, RunState.parse(input.to));
        if (input.rollback) throw new Error("Fixture rollback");
      }).immediate();
    } catch (error) {
      if (!input.rollback) throw error;
    } finally {
      setWorkspaceUrl(publicUrl);
    }
    return {
      run: run.id,
      changed,
      event: (
        db
          .prepare(
            "SELECT id FROM events WHERE run_id=? AND type=? ORDER BY id DESC LIMIT 1",
          )
          .get(run.id, input.to) as { id: number } | undefined
      )?.id,
    };
  }
  throw new Error("Unknown webhook fixture action");
}
