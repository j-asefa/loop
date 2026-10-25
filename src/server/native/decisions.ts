import type { QueryRow } from "../query-records.js";
import { recordPersonalDecision } from "../personal-decisions.js";
import { createHash } from "node:crypto";
import { db, id, now, emit } from "../db.js";
import { ownedRun, Problem } from "../domain.js";
import { NotDelivered } from "../../adapters/types.js";
import { validateAnswer } from "../../protocol.js";
import { autoApproval, DEFAULT_PERMISSION_MODE } from "../../shared/permission-modes.js";
import { MAX_NATIVE_REQUEST_BYTES } from "../../shared/workspace-events.js";
import { transition, type Run } from "../queue.js";
import type { AdapterEvent } from "../../protocol.js";
import { OWNER, type Live } from "./state.js";

type Context = {
  live: ReadonlyMap<string, Live>;
  interrupt(runId: string, reason?: string): Promise<void>;
  answer: NativeDecisions["answer"];
};

export function finishDecisions(
  state: "resolved" | "expired" | "unknown",
  where: string,
  params: unknown[],
) {
  db.transaction(() => {
    db.prepare(
      `UPDATE native_decisions SET state=? WHERE (${where}) AND state<>?
`,
    ).run(state, ...params, state);
  }).immediate();
}

export function requestApproval(live: Live, input: AdapterEvent) {
  return input.type === "request" && live.run
      ? autoApproval(
          live.sessionMode === undefined
            ? live.permissionMode
            : live.sessionMode === "bypassPermissions"
              ? "bypassPermissions"
              : DEFAULT_PERMISSION_MODE,
          input.request,
        )
      : undefined;
}

export class NativeDecisions {
  constructor(private readonly context: Context) {}

  request(live: Live, run: Run, event: Extract<AdapterEvent, { type: "request" }>, allow: string | undefined) {
    if (
      Buffer.byteLength(JSON.stringify(event.request)) > MAX_NATIVE_REQUEST_BYTES ||
      live.requests.size >= 25
    ) {
      void this.context.interrupt(
        run.id,
        "Native decision exceeds safe display bounds.",
      );
      return false;
    }
    live.requests.set(event.request.id, event.request);
    const decisionId = id();
    const recorded = db.transaction(() => {
      const changed = db
        .prepare(
          "INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(conversation_id,generation,native_id) DO NOTHING",
        )
        .run(
          decisionId,
          run.id,
          live.binding.conversation_id,
          live.generation,
          event.request.id,
          JSON.stringify(event.request),
          now(),
        ).changes;
      return changed;
    }).immediate();
    if (recorded && allow) {
      // "Never ask" answers routine tool approvals for the user. Questions
      // and forms requiring input have no allow choice and still wait. A failed
      // answer is left visible as unknown and is never retried.
      void this.context.answer(decisionId, "auto:" + decisionId, {
        choice: allow,
      }).then(
        () =>
          emit(run.owner_id, run.id, "approval.auto_approved", {
            decisionId,
            title: event.request.title,
          }),
        () => {
          transition(run, "awaiting_approval");
          live.waiting = true;
        },
      );
    } else {
      transition(run, "awaiting_approval");
      live.waiting = true;
    }
    return true;
  }

  async answer(
    decisionId: string,
    commandId: string,
    answer: Record<string, unknown>,
  ) {
    const d = db
      .prepare("SELECT * FROM native_decisions WHERE id=?")
      .get(decisionId) as QueryRow<"native_decisions"> | undefined;
    if (!d) throw new Problem(404, "Native decision not found.");
    const digest = createHash("sha256")
      .update(JSON.stringify(answer))
      .digest("hex");
    if (d.command_id === commandId) {
      if (d.digest !== digest)
        throw new Problem(409, "Command ID belongs to different input.");
      return { state: d.state };
    }
    const live = this.context.live.get(d.conversation_id);
    const run = ownedRun(d.run_id, OWNER);
    if (
      !live ||
      live.closed ||
      live.generation !== d.generation ||
      live.run?.id !== d.run_id ||
      d.state !== "pending" ||
      !["running", "awaiting_approval"].includes(run.state)
    )
      throw new Problem(
        409,
        "This native decision expired or was already handled.",
      );
    try {
      validateAnswer(JSON.parse(d.request), answer);
    } catch (e) {
      throw new Problem(400, (e as Error).message);
    }
    db.transaction(() => {
      const claimed = db.prepare(
        "UPDATE native_decisions SET state='deciding',command_id=?,digest=? WHERE id=? AND state='pending'",
      ).run(commandId, digest, decisionId).changes;
      if (!claimed) throw new Problem(409, "This native decision was already handled.");
      if (!commandId.startsWith("auto:"))
        recordPersonalDecision({
          owner: run.owner_id,
          run: run.id,
          native: decisionId,
          request: JSON.parse(d.request),
          answer,
        });
    }).immediate();
    try {
      await live.adapter.answer(d.native_id, answer);
      finishDecisions("resolved", "id=?", [decisionId]);
      return { state: "resolved" };
    } catch (error) {
      // The harness explicitly refused the answer and is still waiting:
      // nothing was applied, so the decision opens for another answer.
      if (error instanceof NotDelivered) {
        // Only while the same run and native session still wait for it. A
        // run that ended meanwhile expires the decision, as it would have.
        const outcome = db.transaction(() => {
          const current = this.context.live.get(d.conversation_id);
          const runState = (db.prepare("SELECT state FROM runs WHERE id=?").get(d.run_id) as { state: string } | undefined)?.state;
          let reopened = 0;
          if (
            current === live &&
            !live.closed &&
            live.generation === d.generation &&
            live.run?.id === d.run_id &&
            ["running", "awaiting_approval"].includes(runState ?? "")
          ) {
            reopened = db.prepare(
              "UPDATE native_decisions SET state='pending',command_id=NULL,digest=NULL WHERE id=? AND state='deciding'",
            ).run(decisionId).changes;
          } else
            finishDecisions("expired", "id=? AND state='deciding'", [decisionId]);
          const stored = db.prepare("SELECT state FROM native_decisions WHERE id=?")
            .get(decisionId) as { state: string } | undefined;
          // Definitive non-delivery is not an answer, even if the run ended.
          // Preserve only a response the harness already confirmed meanwhile.
          if (stored?.state !== "resolved")
            db.prepare("DELETE FROM personal_decisions WHERE native_decision_id=?").run(decisionId);
          return { reopened, state: stored?.state };
        }).immediate();
        if (outcome.reopened) throw new Problem(409, `${error.message} Answer again.`);
        // The harness resolved it meanwhile: report what is stored.
        if (outcome.state === "resolved") return { state: "resolved" };
        throw new Problem(409, "This native decision expired or was already handled.");
      }
      // A harness resolution can arrive before the answer transport finishes.
      // A later transport failure must not undo that confirmation or record it
      // a second time. An unconfirmed answer stays uncertain and is not replayed.
      finishDecisions("unknown", "id=? AND state='deciding'", [decisionId]);
      const current = db.prepare("SELECT state FROM native_decisions WHERE id=?")
        .get(decisionId) as { state: string } | undefined;
      if (current?.state === "resolved") return { state: "resolved" };
      throw new Problem(
        409,
        "Decision outcome is unknown. It was not retried; inspect the native session.",
      );
    }
  }
}
