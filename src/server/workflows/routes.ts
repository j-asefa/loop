import { runResponse } from "../row-schemas.js";

import { teamFilter } from "../teams.js";
import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "../db.js";
import { ownedWorkflow, ownedApproval, ownedRun, Problem } from "../domain.js";
import { compile, bind } from "./compiler.js";
import { startWorkflow } from "./runtime.js";
import { saveArtifact } from "../artifacts.js";
import { decide } from "../approvals.js";
export const workflows = Router();
workflows.get("/workflows", (_req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM workflows WHERE owner_id=? ORDER BY created_at DESC",
      )
      .all(res.locals.owner),
  ),
);
workflows.post("/workflows/validate", (req, res) => {
  const source = z.string().max(100000).parse(req.body.source);
  const spec = compile(source);
  const bindings = bind(res.locals.owner, spec);
  res.json({
    spec,
    bindings,
    notice: `Up to ${spec.limits.maxCalls} model calls, each capped at ${spec.limits.maxOutputTokens} output tokens. Provider pricing applies.`,
  });
});
workflows.post("/workflows", (req, res) => {
  const d = z
    .object({
      source: z.string().max(100000),
      id: z.string().optional(),
      expectedVersion: z.number().int().optional(),
    })
    .parse(req.body);
  const spec = compile(d.source);
  bind(res.locals.owner, spec);
  const prior = d.id ? ownedWorkflow(d.id, res.locals.owner) : null;
  if (prior && prior.version !== d.expectedVersion)
    throw new Problem(409, "Workflow changed. Reopen the latest version.");
  const workflowId = prior?.id || id(),
    version = (prior?.version || 0) + 1;
  db.transaction(() => {
    if (prior)
      db.prepare(
        "UPDATE workflows SET title=?,version=?,source=?,compiled=? WHERE id=?",
      ).run(spec.title, version, d.source, JSON.stringify(spec), workflowId);
    else
      db.prepare("INSERT INTO workflows VALUES(?,?,?,?,?,?,?)").run(
        workflowId,
        res.locals.owner,
        spec.title,
        version,
        d.source,
        JSON.stringify(spec),
        now(),
      );
    db.prepare("INSERT INTO workflow_versions VALUES(?,?,?,?,?)").run(
      workflowId,
      version,
      d.source,
      JSON.stringify(spec),
      now(),
    );
    saveArtifact(res.locals.owner, {
      title: spec.title + ` · v${version}`,
      kind: "workflow",
      content: d.source,
      folder: spec.folderId,
      metadata: { workflowId, version, dsl: spec.dsl },
    });
  }).immediate();
  res.json(ownedWorkflow(workflowId, res.locals.owner));
});
workflows.get("/workflows/:id", (req, res) => {
  const w = ownedWorkflow(req.params.id, res.locals.owner);
  res.json({
    ...w,
    versions: db
      .prepare(
        "SELECT version,source,created_at FROM workflow_versions WHERE workflow_id=? ORDER BY version DESC",
      )
      .all(w.id),
    runs: db
      .prepare(
        "SELECT * FROM runs WHERE owner_id=? AND kind='workflow' AND json_extract(payload,'$.workflowId')=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(res.locals.owner, w.id),
  });
});
workflows.post("/workflows/:id/run", (req, res) => {
  const d = z
    .object({
      version: z.number().int().min(1),
      inputs: z.record(z.string(), z.string()),
      idempotencyKey: z.string().min(8).max(150),
    })
    .parse(req.body);
  res
    .status(202)
    .json(
      runResponse(startWorkflow(
        res.locals.owner,
        req.params.id,
        d.version,
        d.inputs,
        d.idempotencyKey,
      )),
    );
});
workflows.get("/runs/:id/steps", (req, res) => {
  ownedRun(req.params.id, res.locals.owner);
  res.json(
    db
      .prepare(
        "SELECT s.*,r.conversation_id,r.state child_state FROM workflow_steps s LEFT JOIN runs r ON r.id=s.child_run_id WHERE s.run_id=? ORDER BY position",
      )
      .all(req.params.id),
  );
});
workflows.get("/approvals", (req, res) => {
  const teams = teamFilter(req.query.teams, res.locals.owner);
  const filter = teams.length
    ? " AND json_extract(r.payload,'$.teamId') IN (" +
      teams.map(() => "?").join(",") +
      ")"
    : "";
  res.json(
    db
      .prepare(
        "SELECT a.*,r.conversation_id,r.input,agent.name,agent.provider FROM approvals a JOIN runs r ON r.id=a.run_id AND r.owner_id=a.owner_id LEFT JOIN agents agent ON agent.id=r.agent_id AND agent.owner_id=a.owner_id WHERE a.owner_id=? AND a.state='pending' AND r.state='awaiting_approval'" +
          filter +
          " ORDER BY a.created_at",
      )
      .all(res.locals.owner, ...teams),
  );
});
workflows.post("/approvals/:id", async (req, res) => {
  const d = z
    .object({ decision: z.enum(["approve", "reject"]) })
    .parse(req.body);
  const approval = ownedApproval(req.params.id, res.locals.owner);
  res.json(decide(res.locals.owner, req.params.id, d.decision));
});
