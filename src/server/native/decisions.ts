import * as nativeDecisionsQueries from "../sql/native-decisions.js";
import * as personalDecisionsQueries from "../sql/personal-decisions.js";
import * as runsQueries from "../sql/runs.js";
import { assertFleetAction } from "../fleet-action-context.js";
import { ExecutionRefused } from "../execution-refusal.js";
import {
  assertEffect,
  recordEffectEdit,
  discardEffectEdit,
} from "../effect-authority.js";
import type { QueryRow } from "../query-records.js";
import { recordPersonalDecision } from "../personal-decisions.js";
import { createHash } from "node:crypto";
import { db, id, now, emit } from "../db.js";
import { ownedRun, Problem } from "../domain.js";
import { NotDelivered } from "../../adapters/types.js";
import { validateAnswer } from "../../shared/protocol.js";
import {
  autoApproval,
  DEFAULT_PERMISSION_MODE,
} from "../../shared/permission-modes.js";
import { MAX_NATIVE_REQUEST_BYTES } from "../../shared/workspace-events.js";
import { transition, type Run } from "../queue.js";
import type { AdapterEvent } from "../../adapters/events.js";
import { type Live } from "./state.js";
import { OWNER } from "../workspace-identity.js";

type Context = {
  live: ReadonlyMap<string, Live>;
  interrupt(runId: string, reason?: string): Promise<void>;
  answer: NativeDecisions["answer"];
};

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

  request(
    live: Live,
    run: Run,
    event: Extract<AdapterEvent, { type: "request" }>,
    allow: string | undefined,
  ) {
    // Settled ids are ignored before applying bounds to new display content.
    // Re-emissions neither add a request nor make an uncertain answer replayable.
    const existing = nativeDecisionsQueries.byRequest(
      db,
      live.binding.conversation_id,
      live.generation,
      event.request.id,
    );
    if (existing && existing !== "pending") return false;
    if (
      Buffer.byteLength(JSON.stringify(event.request)) >
        MAX_NATIVE_REQUEST_BYTES ||
      live.requests.size >= 25
    ) {
      void this.context.interrupt(
        run.id,
        "Native decision exceeds safe display bounds.",
      );
      return false;
    }
    const decisionId = id();
    const recorded = db
      .transaction(() => {
        const changed = nativeDecisionsQueries.insertPending(
          db,
          decisionId,
          run.id,
          live.binding.conversation_id,
          live.generation,
          event.request.id,
          JSON.stringify(event.request),
          now(),
        ).changes;
        return changed;
      })
      .immediate();
    if (!recorded) {
      // A request id the harness already answered in this generation must not
      // re-ask or send the run back to awaiting_approval with no decision to
      // answer; ignore the re-emitted event. For a resolved/expired decision
      // the request is done. An 'unknown' decision's answer may already have
      // applied some effect, so it is deliberately never replayed and a re-ask
      // is ignored rather than risk double-applying an uncertain effect. A
      // still-pending re-emit is a genuine duplicate and proceeds below.
      const existing = nativeDecisionsQueries.byRequest(
        db,
        live.binding.conversation_id,
        live.generation,
        event.request.id,
      );
      if (existing && existing !== "pending") return false;
    }
    live.requests.set(event.request.id, event.request);
    if (recorded && allow) {
      // "Never ask" answers routine tool approvals for the user. Questions
      // and forms requiring input have no allow choice and still wait. A failed
      // answer is left visible as unknown and is never retried.
      void this.context
        .answer(decisionId, "auto:" + decisionId, {
          choice: allow,
        })
        .then(
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
    const d = nativeDecisionsQueries.get(db, decisionId) as
      QueryRow<"native_decisions"> | undefined;
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
    const edit = db
      .transaction(() => {
        assertFleetAction(run.owner_id);
        assertEffect(run.owner_id, "run", run.id);
        const edit = recordEffectEdit(run.owner_id, "run", run.id);
        const claimed = nativeDecisionsQueries.beginAnswer(
          db,
          commandId,
          digest,
          decisionId,
        ).changes;
        if (!claimed)
          throw new Problem(409, "This native decision was already handled.");
        if (!commandId.startsWith("auto:"))
          recordPersonalDecision({
            owner: run.owner_id,
            run: run.id,
            native: decisionId,
            request: JSON.parse(d.request),
            answer,
          });
        return edit;
      })
      .immediate();
    try {
      await live.adapter.answer(d.native_id, answer, () => {
        const current = nativeDecisionsQueries.decisionReceipt(
          db,
          decisionId,
        ) as
          | Pick<
              QueryRow<"native_decisions">,
              "state" | "command_id" | "digest"
            >
          | undefined;
        if (
          this.context.live.get(d.conversation_id) !== live ||
          live.closed ||
          live.cancelling ||
          live.generation !== d.generation ||
          live.run?.id !== d.run_id ||
          current?.state !== "deciding" ||
          current.command_id !== commandId ||
          current.digest !== digest ||
          !["running", "awaiting_approval"].includes(
            ownedRun(d.run_id, run.owner_id).state,
          )
        )
          throw new NotDelivered("This native decision is no longer active.");
        try {
          assertFleetAction(run.owner_id);
          assertEffect(run.owner_id, "run", run.id);
        } catch (error) {
          // This callback runs before answer IO, so a revoked admission is
          // definitive non-delivery and may use the normal recovery below.
          if (error instanceof ExecutionRefused)
            throw new NotDelivered(error.message);
          throw error;
        }
      });
      nativeDecisionsQueries.finishById(db, "resolved", decisionId);
      return { state: "resolved" };
    } catch (error) {
      // The harness explicitly refused the answer and is still waiting:
      // nothing was applied, so the decision opens for another answer.
      if (error instanceof NotDelivered) {
        // Only while the same run and native session still wait for it. A
        // run that ended meanwhile expires the decision, as it would have.
        const outcome = db
          .transaction(() => {
            const current = this.context.live.get(d.conversation_id);
            const runState = (
              runsQueries.state(db, d.run_id) as { state: string } | undefined
            )?.state;
            let reopened = 0;
            if (
              current === live &&
              !live.closed &&
              live.generation === d.generation &&
              live.run?.id === d.run_id &&
              ["running", "awaiting_approval"].includes(runState ?? "")
            ) {
              reopened = nativeDecisionsQueries.reopen(db, decisionId).changes;
            } else
              nativeDecisionsQueries.finishDecidingById(
                db,
                "expired",
                decisionId,
              );
            const stored = nativeDecisionsQueries.state(db, decisionId) as
              { state: string } | undefined;
            // Definitive non-delivery is not an answer, even if the run ended.
            // Preserve only a response the harness already confirmed meanwhile.
            if (stored?.state !== "resolved") {
              discardEffectEdit(edit);
              personalDecisionsQueries.removeNativeDecision(db, decisionId);
            }
            return { reopened, state: stored?.state };
          })
          .immediate();
        if (outcome.reopened)
          throw new Problem(409, `${error.message} Answer again.`);
        // The harness resolved it meanwhile: report what is stored.
        if (outcome.state === "resolved") return { state: "resolved" };
        throw new Problem(
          409,
          "This native decision expired or was already handled.",
        );
      }
      // A harness resolution can arrive before the answer transport finishes.
      // A later transport failure must not undo that confirmation or record it
      // a second time. An unconfirmed answer stays uncertain and is not replayed.
      nativeDecisionsQueries.finishDecidingById(db, "unknown", decisionId);
      const current = nativeDecisionsQueries.state(db, decisionId) as
        { state: string } | undefined;
      if (current?.state === "resolved") return { state: "resolved" };
      throw new Problem(
        409,
        "Decision outcome is unknown. It was not retried; inspect the native session.",
      );
    }
  }
}
