import * as approvalsQueries from "../sql/approvals.js";
import * as workflowsQueries from "../sql/workflows.js";
import * as workflowVersionsQueries from "../sql/workflow-versions.js";
import * as workflowStepsQueries from "../sql/workflow-steps.js";
import * as runsQueries from "../sql/runs.js";
import { approvalTokenWrite } from "../token-write-policies.js";
import { registrar, projectResponse } from "../registrar.js";
import { workspaceApi } from "../../shared/workspace-api.js";

import { InvalidRow, runResponse } from "../row-schemas.js";

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
routes.on(workspaceApi.workflowList, (_req, res) => {
  try {
    res.json(
      projectResponse(
        workspaceApi.workflowList,
        workflowsQueries.forOwner(db, res.locals.owner),
      ),
    );
  } catch (error) {
    if (error instanceof InvalidRow)
      throw new Problem(
        500,
        "The workspace response is unavailable. Please try again.",
      );
    throw error;
  }
});
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
      workflowsQueries.save(
        db,
        spec.title,
        version,
        d.source,
        JSON.stringify(spec),
        workflowId,
      );
    else
      workflowsQueries.insert(
        db,
        workflowId,
        res.locals.owner,
        spec.title,
        version,
        d.source,
        JSON.stringify(spec),
        now(),
      );
    workflowVersionsQueries.insert(
      db,
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
      versions: workflowVersionsQueries.history(db, w.id),
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
      workflowStepsQueries.withChild(db, req.params.id),
    ),
  );
});
routes.on(workspaceApi.approvals, (req, res) => {
  const teams = teamFilter(req.query.teams, res.locals.owner);
  res.json(
    approvalsQueries.pendingTeams(db, res.locals.owner, teams) as z.input<
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
