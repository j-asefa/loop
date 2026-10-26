import { QueryRecords, type QueryRow } from "../query-records.js";

import { maybeRun, workflowPayload } from "../row-schemas.js";
import { db, emit, id, now } from "../db.js";
import { ownedWorkflow, ownedApproval, ownedRun, Problem } from "../domain.js";
import { enqueue, transition, type Run } from "../queue.js";
import { saveArtifact } from "../artifacts.js";
import { requestApproval } from "../approvals.js";
import { compile, bind, interpolate } from "./compiler.js";

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
  const v = db
    .prepare(
      "SELECT * FROM workflow_versions WHERE workflow_id=? AND version=?",
    )
    .get(workflow.id, version) as QueryRow<"workflow_versions"> | undefined;
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
  const prior = maybeRun(
    db
      .prepare("SELECT * FROM runs WHERE owner_id=? AND idempotency_key=?")
      .get(owner, key),
  );
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
  const p = workflowPayload(run);
  const state = (
    db.prepare("SELECT state FROM runs WHERE id=?").get(run.id) as {
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
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(
      JSON.stringify(p),
      run.id,
    );
  }
  // Approval waiting is excluded from active execution time; per-step provider calls also have timeouts.
  const activeSeconds =
    (
      db
        .prepare(
          "SELECT COALESCE(sum(r.active_ms + CASE WHEN r.active_since IS NOT NULL THEN max(0,?-r.active_since) ELSE 0 END),0) ms FROM workflow_steps s JOIN runs r ON r.id=s.child_run_id WHERE s.run_id=?",
        )
        .get(now(), run.id) as { ms: number }
    ).ms / 1000;
  if (activeSeconds > p.spec.limits.maxRunSeconds)
    throw new Problem(422, "Workflow exceeded its active runtime budget");
  const outputs: Record<string, string> = {};
  for (let position = 0; position < p.spec.steps.length; position++) {
    const step = p.spec.steps[position];
    let checkpoint = db
      .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
      .get(run.id, step.id) as QueryRow<"workflow_steps"> | undefined;
    if (checkpoint?.state === "completed") {
      outputs[step.id] = checkpoint.output || "";
      continue;
    }
    if (!checkpoint) {
      db.prepare(
        "INSERT INTO workflow_steps(run_id,step_id,position,state) VALUES(?,?,?,'pending')",
      ).run(run.id, step.id, position);
      checkpoint = QueryRecords.workflow_steps.parse(
        db
          .prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_id=?")
          .get(run.id, step.id),
      );
    }
    if (step.type === "agent") {
      if (checkpoint.child_run_id) {
        const child = ownedRun(checkpoint.child_run_id, run.owner_id);
        if (child.state === "completed") {
          db.prepare(
            "UPDATE workflow_steps SET state='completed',output=? WHERE run_id=? AND step_id=?",
          ).run(child.result || "", run.id, step.id);
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
        db.prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
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
        db.prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'user',?,?)",
        ).run(id(), run.owner_id, conversation, child.id, prompt, now());
        db.prepare(
          "UPDATE workflow_steps SET state='running',child_run_id=? WHERE run_id=? AND step_id=?",
        ).run(child.id, run.id, step.id);
        db.prepare(
          "UPDATE runs SET worker_id=NULL,heartbeat=NULL WHERE id=?",
        ).run(run.id);
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
        db.prepare(
          "UPDATE workflow_steps SET approval_id=? WHERE run_id=? AND step_id=?",
        ).run(approval.id, run.id, step.id);
      }
      if (approval.state === "approved" || approval.state === "completed") {
        db.transaction(() => {
          db.prepare("UPDATE approvals SET state='completed' WHERE id=?").run(
            approval.id,
          );
          db.prepare(
            "UPDATE workflow_steps SET state='completed',output=? WHERE run_id=? AND step_id=?",
          ).run(outputs[step.source], run.id, step.id);
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
      db.prepare(
        "UPDATE runs SET worker_id=NULL,heartbeat=NULL WHERE id=?",
      ).run(run.id);
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
        db.prepare(
          "UPDATE workflow_steps SET state='completed',output=?,artifact_id=? WHERE run_id=? AND step_id=?",
        ).run(content, artifactId, run.id, step.id);
      }).immediate();
      outputs[step.id] = content;
    }
  }
  const result = Object.fromEntries(
    Object.entries(p.spec.outputs).map(([name, step]) => [name, outputs[step]]),
  );
  db.prepare("UPDATE runs SET result=? WHERE id=?").run(
    JSON.stringify(result),
    run.id,
  );
  emit(run.owner_id, run.id, "workflow.completed", { outputs: result });
  return true;
}
