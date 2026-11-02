import * as runsQueries from "../sql/runs.js";
import { approvalTokenWrite } from "../token-write-policies.js";
import { registrar, projectResponse } from "../registrar.js";
import { workspaceApi } from "../../shared/workspace-api.js";

import { runResponse } from "../row-schemas.js";

import { teamFilter } from "../teams.js";

import { z } from "zod";
import { db, id, now } from "../db.js";
import { ownedWorkflow, ownedApproval, ownedRun, Problem } from "../domain.js";
import { compile, bind } from "./compiler.js";
import { startWorkflow } from "./runtime.js";
import { saveArtifact } from "../artifacts.js";
import { decide } from "../approvals.js";
const routes = registrar("workflows");
export const workflows = routes.mount;
routes.on(workspaceApi.workflowList, (_req, res) =>
  res.json(
    projectResponse(
      workspaceApi.workflowList,
      db
        .prepare(
          "SELECT * FROM workflows WHERE owner_id=? ORDER BY created_at DESC",
        )
        .all(res.locals.owner),
    ),
  ),
);
routes.on(workspaceApi.workflowValidate, (req, res) => {
  const source = req.body.source;
  const spec = compile(source);
  const bindings = bind(res.locals.owner, spec);
  res.json(
    projectResponse(workspaceApi.workflowValidate, {
      spec,
      bindings,
      notice: `Up to ${spec.limits.maxCalls} model calls, each capped at ${spec.limits.maxOutputTokens} output tokens. Provider pricing applies.`,
    }),
  );
});
routes.on(workspaceApi.workflowSave, (req, res) => {
  const d = req.body;
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
  res.json(
    projectResponse(
      workspaceApi.workflowSave,
      ownedWorkflow(workflowId, res.locals.owner),
    ),
  );
});
routes.on(workspaceApi.workflowDetail, (req, res) => {
  const w = ownedWorkflow(req.params.id, res.locals.owner);
  res.json(
    projectResponse(workspaceApi.workflowDetail, {
      ...w,
      versions: db
        .prepare(
          "SELECT version,source,created_at FROM workflow_versions WHERE workflow_id=? ORDER BY version DESC",
        )
        .all(w.id),
      runs: runsQueries.workflowHistory(db, res.locals.owner, w.id),
    }),
  );
});
routes.on(workspaceApi.workflowRun, (req, res) => {
  const d = req.body;
  res
    .status(202)
    .json(
      runResponse(
        startWorkflow(
          res.locals.owner,
          req.params.id,
          d.version,
          d.inputs,
          d.idempotencyKey,
        ),
      ),
    );
});
routes.on(workspaceApi.workflowSteps, (req, res) => {
  ownedRun(req.params.id, res.locals.owner);
  res.json(
    projectResponse(
      workspaceApi.workflowSteps,
      db
        .prepare(
          "SELECT s.*,r.conversation_id,r.state child_state FROM workflow_steps s LEFT JOIN runs r ON r.id=s.child_run_id WHERE s.run_id=? ORDER BY position",
        )
        .all(req.params.id),
    ),
  );
});
routes.on(workspaceApi.approvals, (req, res) => {
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
      .all(res.locals.owner, ...teams) as z.input<
      typeof workspaceApi.approvals.response
    >,
  );
});
routes.on(
  workspaceApi.approval,
  (req, res) => {
    const approval = ownedApproval(req.params.id, res.locals.owner);
    res.json(decide(res.locals.owner, req.params.id, req.body.decision));
  },
  { tokenWrite: approvalTokenWrite },
);
