import { randomUUID } from "node:crypto";
import {
  BeadsNotStarted,
  BeadsPreconditionFailed,
  type BeadsStore,
} from "../beads-runtime.js";
import { parsePullRequestUrls, pullRequestUrl } from "../shared/github.js";
import { runResultId } from "../shared/result.js";
import { isTerminalRunState } from "../shared/run-state.js";
import { submit, nextTurnConnection } from "./agent-runtime.js";
import { db, now } from "./db.js";
import { ownedAgent, Problem } from "./domain.js";
import { enabledStore, issue } from "./project-beads.js";
import { projectFolders } from "./results.js";
import * as agentsQueries from "./sql/agents.js";
import * as assignmentsQueries from "./sql/bead-assignments.js";
import * as dispatchQueries from "./sql/native-dispatch.js";
import * as resultsQueries from "./sql/results.js";
import * as runsQueries from "./sql/runs.js";
import * as teamsQueries from "./sql/teams.js";

type Assignment = assignmentsQueries.BeadAssignment;

function eligibleAgent(owner: string, project: string, id: string) {
  const agent = ownedAgent(id, owner);
  if (
    agent.retired_at ||
    !projectFolders(owner, project).includes(agent.folder_id) ||
    teamsQueries.hasReviewAgent(db, owner, agent.id)
  )
    throw new Problem(409, "Choose an eligible agent in this project.");
  nextTurnConnection(owner, agent);
  return agent;
}

export function eligibleBeadAgents(owner: string, project: string) {
  enabledStore(owner, project);
  return agentsQueries.forOwner(db, owner).flatMap(({ id, name }) => {
    try {
      eligibleAgent(owner, project, id);
      return [{ id, name }];
    } catch (error) {
      if (error instanceof Problem) return [];
      throw error;
    }
  });
}

function claimActor(row: Assignment) {
  return "loop-start-" + row.generation;
}

function mayRelease(row: Assignment) {
  if (row.state === "prepared" || row.state === "claimed") return true;
  if (row.state !== "started" || !row.run_id) return false;
  const run = runsQueries.ownedState(db, row.run_id, row.owner_id);
  return (
    !!run &&
    isTerminalRunState(run.state) &&
    !dispatchQueries.hasAcceptedOrUnknown(db, row.run_id)
  );
}

function publicAssignment(row: Assignment) {
  const run = row.run_id
    ? runsQueries.owned(db, row.run_id, row.owner_id)
    : undefined;
  const result = run
    ? resultsQueries.canonicalById(db, row.owner_id, runResultId(run.id))
    : undefined;
  return {
    requestId: row.request_id,
    generation: row.generation,
    agentId: row.agent_id,
    state: row.state,
    canResume: row.state === "prepared" || row.state === "claimed",
    canRelease: mayRelease(row),
    conversationId: run?.conversation_id ?? null,
    result: result
      ? {
          id: result.id,
          conversationId: result.provenance.conversationId,
          messageId: result.provenance.messageId,
          title: result.outcome.title,
        }
      : null,
    pulls: result
      ? parsePullRequestUrls(result.outcome.body).map(pullRequestUrl)
      : [],
  };
}

/** Read-only recovery. Finding a claim proves only the claim, never a launch. */
async function reconcile(store: BeadsStore, row: Assignment) {
  if (row.state !== "claiming" && row.state !== "releasing") return row;
  const bead = await issue(store, row.bead_id);
  let next: "claimed" | "released" | undefined;
  if (
    row.state === "claiming" &&
    bead.assignee === claimActor(row) &&
    bead.status === "in_progress"
  )
    next = "claimed";
  if (
    row.state === "releasing" &&
    bead.metadata?.loop_release === row.generation
  )
    next = "released";
  if (next) assignmentsQueries.transition(db, row, next);
  return assignmentsQueries.byRequest(db, row.owner_id, row.request_id)!;
}

function dispatchStart(row: Assignment, project: string, title: string) {
  return db
    .transaction(() => {
      const current = assignmentsQueries.active(
        db,
        row.owner_id,
        row.store_id,
        row.bead_id,
      );
      if (current?.generation !== row.generation || current.state !== "claimed")
        return assignmentsQueries.byRequest(db, row.owner_id, row.request_id)!;
      // submit only inserts queued Loop work. The normal worker owns execution
      // and its native receipt. The queue item and association commit together.
      eligibleAgent(row.owner_id, project, row.agent_id);
      const run = submit(row.owner_id, {
        agentId: row.agent_id,
        folderId: project,
        idempotencyKey: "bead-start:" + row.generation,
        mailScope: "direct",
        personal: true,
        input:
          "Work on " +
          row.bead_id +
          " (" +
          title +
          "). Read the bead and its discussion with the Project Work tool. Verify the bead's acceptance criteria before explicitly closing it with a reason. Finishing this turn does not close the bead.",
      });
      assignmentsQueries.transition(db, current, "started", run.id);
      return assignmentsQueries.byRequest(db, row.owner_id, row.request_id)!;
    })
    .immediate();
}

async function claimAndStart(
  store: BeadsStore,
  row: Assignment,
  project: string,
) {
  if (row.state === "prepared") {
    if (!assignmentsQueries.transition(db, row, "claiming"))
      return publicAssignment(
        await reconcile(
          store,
          assignmentsQueries.byRequest(db, row.owner_id, row.request_id)!,
        ),
      );
    const actor = claimActor(row);
    const claiming = { ...row, state: "claiming" as const };
    try {
      await store.write(
        [
          "--actor",
          actor,
          "update",
          row.bead_id,
          "--if-status",
          "open",
          "--if-assignee",
          "",
          "--status",
          "in_progress",
          "--assignee",
          actor,
        ],
        { ready: row.bead_id },
      );
    } catch (error) {
      if (error instanceof BeadsPreconditionFailed)
        assignmentsQueries.transition(db, claiming, "refused");
      if (error instanceof BeadsNotStarted)
        assignmentsQueries.transition(db, claiming, "prepared");
      return publicAssignment(
        await reconcile(
          store,
          assignmentsQueries.byRequest(db, row.owner_id, row.request_id)!,
        ),
      );
    }
    row = await reconcile(store, claiming);
  }
  if (row.state === "claimed") {
    const bead = await issue(store, row.bead_id);
    if (bead.status !== "in_progress" || bead.assignee !== claimActor(row))
      throw new Problem(409, "The assignment is no longer current.");
    row = dispatchStart(row, project, bead.title);
  }
  return publicAssignment(row);
}

export async function startBead(
  owner: string,
  project: string,
  bead: string,
  input: { storeId: string; requestId: string; agentId: string },
) {
  const store = enabledStore(owner, project, input.storeId);
  const { existing, row } = db
    .transaction(() => {
      const prior = assignmentsQueries.byRequest(db, owner, input.requestId);
      if (prior) {
        if (
          prior.store_id !== store.id ||
          prior.bead_id !== bead ||
          prior.agent_id !== input.agentId
        )
          throw new Problem(409, "This request belongs to another assignment.");
        return { existing: true, row: prior };
      }
      eligibleAgent(owner, project, input.agentId);
      if (assignmentsQueries.active(db, owner, store.id, bead))
        throw new Problem(
          409,
          "This bead already has a claim or recovery in progress.",
        );
      assignmentsQueries.prepare(db, {
        owner_id: owner,
        store_id: store.id,
        bead_id: bead,
        request_id: input.requestId,
        generation: randomUUID(),
        agent_id: input.agentId,
        created_at: now(),
      });
      return {
        existing: false,
        row: assignmentsQueries.byRequest(db, owner, input.requestId)!,
      };
    })
    .immediate();
  return existing
    ? publicAssignment(await reconcile(store, row))
    : claimAndStart(store, row, project);
}

export async function changeBeadAssignment(
  owner: string,
  project: string,
  beadId: string,
  input: { storeId: string; generation: string; action: "resume" | "release" },
) {
  const store = enabledStore(owner, project, input.storeId);
  const active = assignmentsQueries.active(db, owner, store.id, beadId);
  if (!active || active.generation !== input.generation)
    throw new Problem(409, "This assignment changed. Reopen the bead.");
  const row = await reconcile(store, active);
  if (input.action === "resume") return claimAndStart(store, row, project);
  if (row.state === "releasing" || row.state === "released")
    return publicAssignment(row);
  if (!mayRelease(row))
    throw new Problem(
      409,
      "The previous run has not been confirmed ended or unsent.",
    );
  const reserved = db
    .transaction(() => {
      const current = assignmentsQueries.active(db, owner, store.id, beadId);
      if (current?.generation !== row.generation || !mayRelease(current))
        throw new Problem(409, "This assignment is no longer releasable.");
      const next: Assignment["state"] =
        current.state === "prepared" ? "released" : "releasing";
      assignmentsQueries.transition(db, current, next);
      return { ...current, state: next };
    })
    .immediate();
  if (reserved.state === "releasing") {
    try {
      await store.write([
        "update",
        beadId,
        "--if-status",
        "in_progress",
        "--if-assignee",
        claimActor(reserved),
        "--status",
        "open",
        "--assignee",
        "",
        "--set-metadata",
        "loop_release=" + reserved.generation,
      ]);
    } catch {
      // The attempt may have committed. Reconcile by marker, without replay.
    }
    return publicAssignment(await reconcile(store, reserved));
  }
  return publicAssignment(reserved);
}

export async function beadAssignmentStatus(
  owner: string,
  project: string,
  bead: string,
) {
  const store = enabledStore(owner, project);
  const active = assignmentsQueries.active(db, owner, store.id, bead);
  const rows = assignmentsQueries.forBead(db, owner, store.id, bead);
  return {
    assignment: active
      ? publicAssignment(await reconcile(store, active))
      : null,
    linkedRuns: rows.map(publicAssignment),
  };
}
