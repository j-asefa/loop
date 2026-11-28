import { z } from "zod";
import { BeadsUnavailable } from "../beads-runtime.js";
import { BeadId } from "../shared/bead-routes.js";
import { db } from "./db.js";
import { ownedRun, Problem } from "./domain.js";
import { canUseMemorySearch } from "./memory.js";
import { requestHash } from "./request-receipts.js";
import type { Run } from "./row-schemas.js";
import {
  closeProjectBead,
  commentOnBead,
  createProjectBead,
  linkBeadDependency,
  projectBead,
  projectWork,
} from "./project-beads.js";
import * as assignmentsQueries from "./sql/bead-assignments.js";
import * as foldersQueries from "./sql/folders.js";
import * as messagesQueries from "./sql/messages.js";
import * as storesQueries from "./sql/project-bead-stores.js";

export const projectWorkTool = z.object({
  action: z.enum(["list", "read", "create", "comment", "dependency", "close"]),
  bead: BeadId.optional(),
  blocker: BeadId.optional(),
  title: z.string().max(256).optional(),
  description: z.string().max(16_000).optional(),
  text: z.string().max(8000).optional(),
  reason: z.string().max(2000).optional(),
});

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("read"), bead: BeadId }),
  z.object({
    action: z.literal("create"),
    title: z.string().trim().min(1).max(256),
    description: z.string().max(16_000).default(""),
  }),
  z.object({
    action: z.literal("comment"),
    bead: BeadId,
    text: z.string().trim().min(1).max(8000),
  }),
  z.object({ action: z.literal("dependency"), bead: BeadId, blocker: BeadId }),
  z.object({
    action: z.literal("close"),
    bead: BeadId,
    reason: z.string().trim().min(1).max(2000),
  }),
]);

function runWorkScope(run: Run) {
  // Watched PR updates, digests, shared input and Fleet mail can carry
  // instructions the workspace owner did not type.
  if (
    !messagesQueries.hasPersonalPrompt(db, run.id, run.owner_id) ||
    !canUseMemorySearch(run)
  )
    return undefined;
  const project = foldersQueries.projectFor(db, {
    owner: run.owner_id,
    folder: run.payload.folderId ?? null,
  });
  return project
    ? storesQueries.forProject(db, run.owner_id, project.id)
    : undefined;
}

export function projectWorkAvailable(run: Run) {
  return !!runWorkScope(run);
}

export async function invokeProjectWork(
  run: Run,
  callId: string,
  input: unknown,
) {
  const current = ownedRun(run.id, run.owner_id);
  if (current.state !== "running" || current.worker_id !== run.worker_id)
    throw new Problem(409, "This run is no longer executing.");
  const scope = runWorkScope(current);
  if (!scope) throw new Problem(404, "Project Work is disabled.");
  const requestId = "tool:" + requestHash([run.id, callId]);
  const parsed = command.safeParse(input);
  if (!parsed.success)
    throw new Problem(
      400,
      "Provide the bead and fields required for this action.",
    );
  const args = parsed.data;
  const owner = run.owner_id;
  const project = scope.project_id;
  const mutation = { requestId, storeId: scope.store_id };
  try {
    switch (args.action) {
      case "list":
        return await projectWork(owner, project);
      case "read":
        return await projectBead(owner, project, args.bead);
      case "create":
        return await createProjectBead(owner, project, {
          ...mutation,
          ...args,
        });
      case "comment":
        return await commentOnBead(
          owner,
          project,
          args.bead,
          { ...mutation, ...args },
          "@" + current.payload.name,
        );
      case "dependency":
        return await linkBeadDependency(owner, project, args.bead, {
          ...mutation,
          blocker: args.blocker,
        });
      case "close": {
        const assignment = assignmentsQueries.forRun(db, owner, run.id);
        if (
          !assignment ||
          assignment.store_id !== scope.store_id ||
          assignment.bead_id !== args.bead
        )
          throw new Problem(
            403,
            "An agent can only close its own assigned bead.",
          );
        return await closeProjectBead(
          owner,
          project,
          args.bead,
          {
            ...mutation,
            generation: assignment.generation,
            reason: args.reason,
          },
          run.id,
        );
      }
    }
  } catch (error) {
    if (error instanceof BeadsUnavailable)
      throw new Problem(503, error.message);
    throw error;
  }
}
