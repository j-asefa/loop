import * as workflowVersionsQueries from "../sql/workflow-versions.js";
import * as workflowStepsQueries from "../sql/workflow-steps.js";
import * as conversationsQueries from "../sql/conversations.js";
import * as approvalsQueries from "../sql/approvals.js";
import * as messagesQueries from "../sql/messages.js";
import * as runsQueries from "../sql/runs.js";
import { QueryRecords, type QueryRow } from "../query-records.js";

import { maybeRun, workflowPayload } from "../row-schemas.js";
import { db, emit, id, now } from "../db.js";
import { ownedWorkflow, ownedApproval, ownedRun, Problem } from "../domain.js";
import { enqueue, transition, type Run } from "../queue.js";
import { saveArtifact } from "../artifacts.js";
import { requestApproval } from "../approvals.js";
import { compile, bind, interpolate } from "./compiler.js";
import {
  assertFleetEffect,
  inheritFleetEffect,
} from "../fleet-effect-authorizations.js";

type WorkflowPayload = import("zod").infer<
  typeof import("../row-schemas.js").WorkflowPayload
>;
export function startWorkflow(
  owner: string,
  workflowId: string,
  version: number,
  inputs: Record<string, string>,
  key: string,
) {
  const workflow = ownedWorkflow(workflowId, owner);
  const v = workflowVersionsQueries.version(db, workflow.id, version) as
    QueryRow<"workflow_versions"> | undefined;
  if (!v) throw new Problem(404, "Workflow version not found");
  const spec = compile(v.source),
    resolved: Record<string, string> = {};
  for (const name of Object.keys(inputs))
    if (!Object.hasOwn(spec.inputs, name))
      throw new Problem(422, `Unexpected input ${name}`);
  for (const [name, decl] of Object.entries(spec.inputs)) {
    const value = inputs[name] ?? decl.default;
    if (value === undefined)
      throw new Problem(422, `Input ${name} is required`);
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > spec.limits.maxInputBytes
    )
      throw new Problem(422, `Input ${name} is too large`);
    resolved[name] = value;
  }
  const prior = maybeRun(runsQueries.byIdempotency(db, owner, key));
  if (prior) {
    const p = prior.payload;
    if (
      prior.kind !== "workflow" ||
      p.workflowId !== workflowId ||
      p.version !== version ||
      JSON.stringify(p.inputs) !== JSON.stringify(resolved)
    )
      throw new Problem(409, "Request key already used");
    return prior;
  }
  return enqueue(owner, spec.title, key, {
    kind: "workflow",
    payload: {
      workflowId,
      version,
      spec,
      inputs: resolved,
      bindings: bind(owner, spec),
    } satisfies WorkflowPayload,
  });
}
export async function executeWorkflow(run: Run): Promise<boolean> {
  assertFleetEffect(run.owner_id, "run", run.id);
  const p = workflowPayload(run);
  const state = (
    runsQueries.state(db, run.id) as {
      state: string;
    }
  ).state;
  if (state === "cancelled") return false;
  if (state === "pausing") {
    transition(run, "paused");
    return false;
  }
  if (!p.startedAt) {
    p.startedAt = now();
    runsQueries.setPayload(db, JSON.stringify(p), run.id);
  }
  // Approval waiting is excluded from active execution time; per-step provider calls also have timeouts.
  const activeSeconds =
    (workflowStepsQueries.activeTime(db, now(), run.id) as { ms: number }).ms /
    1000;
  if (activeSeconds > p.spec.limits.maxRunSeconds)
    throw new Problem(422, "Workflow exceeded its active runtime budget");
  const outputs: Record<string, string> = {};
  for (let position = 0; position < p.spec.steps.length; position++) {
    const step = p.spec.steps[position];
    let checkpoint = workflowStepsQueries.step(db, run.id, step.id) as
      QueryRow<"workflow_steps"> | undefined;
    if (checkpoint?.state === "completed") {
      outputs[step.id] = checkpoint.output || "";
      continue;
    }
    if (!checkpoint) {
      workflowStepsQueries.insertPending(db, run.id, step.id, position);
      checkpoint = QueryRecords.workflow_steps.parse(
        workflowStepsQueries.step(db, run.id, step.id),
      );
    }
    if (step.type === "agent") {
      if (checkpoint.child_run_id) {
        const child = ownedRun(checkpoint.child_run_id, run.owner_id);
        if (child.state === "completed") {
          workflowStepsQueries.complete(
            db,
            child.result || "",
            run.id,
            step.id,
          );
          outputs[step.id] = child.result || "";
          emit(run.owner_id, run.id, "workflow.step.completed", {
            stepId: step.id,
            childRunId: child.id,
            conversationId: child.conversation_id,
          });
          continue;
        }
        if (["failed", "cancelled", "interrupted"].includes(child.state))
          throw new Problem(
            409,
            `Step ${step.id} ${child.state}. No subsequent step ran.`,
          );
        return false;
      }
      const snapshot = p.bindings[step.agent],
        prompt = interpolate(step.prompt, p.inputs, outputs);
      if (
        Buffer.byteLength(prompt + snapshot.instructions) >
        p.spec.limits.maxInputBytes
      )
        throw new Problem(422, `Step ${step.id} exceeds its input budget`);
      db.transaction(() => {
        const conversation = id();
        conversationsQueries.insertOrigin(
          db,
          conversation,
          run.owner_id,
          snapshot.agentId,
          `${p.spec.title} / ${step.id}`,
          "workflow",
          now(),
        );
        const child = enqueue(run.owner_id, prompt, `${run.id}:${step.id}`, {
          agent: snapshot.agentId,
          conversation,
          payload: {
            ...snapshot,
            maxTokens: p.spec.limits.maxOutputTokens,
            maxSeconds: Math.max(
              1,
              p.spec.limits.maxRunSeconds - activeSeconds,
            ),
            workflowRun: run.id,
            workflowStep: step.id,
          },
        });
        inheritFleetEffect(run.owner_id, "run", run.id, child.id);
        messagesQueries.insertWorkflowUser(
          db,
          id(),
          run.owner_id,
          conversation,
          child.id,
          prompt,
          now(),
        );
        workflowStepsQueries.startChild(db, child.id, run.id, step.id);
        runsQueries.clearLease(db, run.id);
        emit(run.owner_id, run.id, "workflow.step.started", {
          stepId: step.id,
          childRunId: child.id,
          conversationId: conversation,
          agent: snapshot.name,
        });
      }).immediate();
      return false;
    } else if (step.type === "approval") {
      let approval = checkpoint.approval_id
        ? ownedApproval(checkpoint.approval_id, run.owner_id)
        : null;
      if (!approval) {
        approval = requestApproval(run, {
          type: "workflow_review",
          stepId: step.id,
          message: step.message,
          content: outputs[step.source],
          workflowId: p.workflowId,
          version: p.version,
        });
        workflowStepsQueries.approval(db, approval.id, run.id, step.id);
      }
      if (approval.state === "approved" || approval.state === "completed") {
        db.transaction(() => {
          approvalsQueries.completeState(db, approval.id);
          workflowStepsQueries.complete(
            db,
            outputs[step.source],
            run.id,
            step.id,
          );
        }).immediate();
        outputs[step.id] = outputs[step.source];
        continue;
      }
      if (approval.state !== "pending" || approval.expires_at < now())
        throw new Problem(409, "Review is rejected or expired");
      transition(run, "awaiting_approval", {
        approvalId: approval.id,
        stepId: step.id,
      });
      runsQueries.clearLease(db, run.id);
      return false;
    } else {
      const content = outputs[step.source];
      db.transaction(() => {
        const artifactId = saveArtifact(run.owner_id, {
          title: step.title,
          content,
          kind: step.kind,
          run: run.id,
          folder: p.spec.folderId,
          metadata: {
            workflowId: p.workflowId,
            version: p.version,
            stepId: step.id,
          },
        });
        workflowStepsQueries.completeArtifact(
          db,
          content,
          artifactId,
          run.id,
          step.id,
        );
      }).immediate();
      outputs[step.id] = content;
    }
  }
  const result = Object.fromEntries(
    Object.entries(p.spec.outputs).map(([name, step]) => [name, outputs[step]]),
  );
  runsQueries.setResult(db, JSON.stringify(result), run.id);
  emit(run.owner_id, run.id, "workflow.completed", { outputs: result });
  return true;
}
