import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BeadsNotStarted,
  BeadsPreconditionFailed,
  BeadsStore,
  BeadsUnavailable,
} from "../beads-runtime.js";
import {
  BeadId,
  type BeadComment,
  type BeadCreate,
  type BeadWorkItem,
} from "../shared/bead-routes.js";
import { config } from "./config.js";
import type { CanonicalResult } from "../shared/result.js";
import { db, now } from "./db.js";
import { ownedConversation, ownedFolder, Problem } from "./domain.js";
import { requestHash, withRequestReceipt } from "./request-receipts.js";
import * as storesQueries from "./sql/project-bead-stores.js";
import * as receiptsQueries from "./sql/bead-write-receipts.js";
import * as resultsQueries from "./sql/results.js";
import * as assignmentsQueries from "./sql/bead-assignments.js";
import * as foldersQueries from "./sql/folders.js";
import * as profilesQueries from "./sql/user-profiles.js";

const nativeIssue = z.object({
  id: BeadId,
  title: z.string(),
  description: z.string().default(""),
  status: z.string(),
  close_reason: z.string().nullish(),
  assignee: z.string().nullish(),
  metadata: z.object({ loop_release: z.string().optional() }).nullish(),
  dependencies: z
    .array(
      z.object({ id: BeadId.optional(), depends_on_id: BeadId.optional() }),
    )
    .nullish(),
});
const issueList = z.array(nativeIssue);
const nativeComment = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string(),
  created_at: z.string(),
});
const blockedList = z.array(
  z.object({ id: BeadId, blocked_by: z.array(BeadId) }),
);
const closeMarker = /\n\n<!-- loop-close:([0-9a-f-]{36}) -->$/;
const commentMarker = /\n\n<!-- loop-comment:([0-9a-f-]{36}) -->$/;

type BeadStatus = {
  status: "committed" | "unknown" | "refused";
  beadId: string;
};

function projectStore(owner: string, project: string) {
  if (ownedFolder(project, owner).kind !== "project")
    throw new Problem(404, "Project not found.");
  // The owning companion's database and data volume are the profile boundary.
  const store = new BeadsStore(config.data, {
    ownerId: owner,
    profile: "companion",
    projectId: project,
  });
  const binding = storesQueries.forProject(db, owner, project);
  if (binding && binding.store_id !== store.id) throw new BeadsUnavailable();
  return { store, enabled: !!binding };
}

export function enabledStore(owner: string, project: string, storeId?: string) {
  const { store, enabled } = projectStore(owner, project);
  if (!enabled) throw new Problem(404, "Project Work is disabled.");
  if (storeId !== undefined && store.id !== storeId)
    throw new Problem(409, "Project Work has changed. Reopen the bead.");
  return store;
}

async function read<T>(
  store: BeadsStore,
  command: readonly string[],
  schema: z.ZodType<T>,
): Promise<T> {
  const result = schema.safeParse(await store.read(command));
  if (!result.success) throw new BeadsUnavailable({ cause: result.error });
  return result.data;
}

export async function issue(store: BeadsStore, bead: string) {
  const [value] = await read(store, ["show", bead], issueList);
  if (!value || value.id !== bead) throw new Problem(404, "Bead not found.");
  return value;
}

function publicIssue(
  bead: z.output<typeof nativeIssue>,
  ready: Set<string>,
  blockedBy: string[],
): BeadWorkItem {
  const status =
    bead.status === "closed" || bead.status === "in_progress"
      ? bead.status
      : ready.has(bead.id)
        ? "ready"
        : "blocked";
  return {
    id: bead.id,
    title: bead.title,
    description: bead.description,
    status,
    dependencies: (bead.dependencies ?? []).flatMap((dependency) => {
      const id = dependency.depends_on_id ?? dependency.id;
      return id ? [id] : [];
    }),
    blockedBy,
    assignee: bead.assignee ?? null,
  };
}

async function classifications(store: BeadsStore) {
  const [ready, blocked] = await Promise.all([
    read(store, ["ready", "--limit", "0"], issueList),
    read(store, ["blocked"], blockedList),
  ]);
  return {
    ready: new Set(ready.map(({ id }) => id)),
    blocked: new Map(blocked.map(({ id, blocked_by }) => [id, blocked_by])),
  };
}

export async function enableProjectWork(owner: string, project: string) {
  const { store, enabled } = projectStore(owner, project);
  if (enabled) {
    await read(store, ["list", "--limit", "1"], issueList);
  } else {
    await store.initialize();
    projectStore(owner, project);
    storesQueries.bind(db, owner, project, store.id);
  }
  return { storeId: store.id };
}

export async function projectWork(owner: string, project: string) {
  const { store, enabled } = projectStore(owner, project);
  if (!enabled) return { enabled: false as const };
  const [items, { ready, blocked }] = await Promise.all([
    read(store, ["list", "--all", "--limit", "0"], issueList),
    classifications(store),
  ]);
  return {
    enabled: true as const,
    storeId: store.id,
    items: items.map((bead) =>
      publicIssue(bead, ready, blocked.get(bead.id) ?? []),
    ),
  };
}

export async function projectBead(owner: string, project: string, id: string) {
  const store = enabledStore(owner, project);
  const [bead, { ready, blocked }, comments] = await Promise.all([
    issue(store, id),
    classifications(store),
    read(store, ["comments", id], z.array(nativeComment)),
  ]);
  const source = receiptsQueries.creation(db, owner, store.id, id);
  const linked = source?.source_result_id
    ? resultsQueries.canonicalById(db, owner, source.source_result_id)
    : undefined;
  return {
    ...publicIssue(bead, ready, blocked.get(id) ?? []),
    storeId: store.id,
    sourceResultId: source?.source_result_id ?? null,
    sourceResult: linked
      ? {
          id: linked.id,
          conversationId: linked.provenance.conversationId,
          messageId: linked.provenance.messageId,
          title: linked.outcome.title,
        }
      : null,
    closeReason: bead.close_reason?.replace(closeMarker, "") ?? null,
    comments: comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      text: comment.text.replace(commentMarker, ""),
      createdAt: comment.created_at,
    })),
  };
}

async function mutate(
  owner: string,
  store: BeadsStore,
  input: { requestId: string },
  operation: "create" | "comment" | "close" | "dependency",
  beadId: string,
  sourceResultId: string | null,
  perform: (marker: string) => Promise<boolean>,
  reconcile: (storedBead: string, marker: string) => Promise<boolean>,
): Promise<BeadStatus> {
  const hash = requestHash({
    operation,
    input,
    target: operation === "create" ? null : beadId,
  });
  const marker = randomUUID();
  const unknown = (id: string): BeadStatus => ({
    status: "unknown",
    beadId: id,
  });
  const committed = (id: string): BeadStatus => ({
    status: "committed",
    beadId: id,
  });
  const prior = receiptsQueries.byRequest(db, owner, input.requestId);
  if (prior?.request_hash === hash && prior.completed_at === null) {
    // An unfinished receipt may still be running in another process. Only
    // accept the external record with the reserved identity. Never repeat it.
    if (
      !(await reconcile(prior.bead_id, prior.correlation_id).catch(() => false))
    )
      return unknown(prior.bead_id);
    receiptsQueries.finish(db, owner, input.requestId, now());
    return committed(prior.bead_id);
  }

  return await withRequestReceipt<BeadStatus>(db, {
    mode: "external",
    reserve: () => {
      const existing = receiptsQueries.byRequest(db, owner, input.requestId);
      if (existing) {
        if (existing.request_hash !== hash)
          return {
            kind: "refused",
            message: "This request belongs to different bead work.",
          };
        return {
          kind: "replay",
          result:
            existing.completed_at === null
              ? unknown(existing.bead_id)
              : committed(existing.bead_id),
        };
      }
      receiptsQueries.reserve(db, {
        owner_id: owner,
        request_id: input.requestId,
        store_id: store.id,
        operation,
        request_hash: hash,
        bead_id: beadId,
        correlation_id: marker,
        source_result_id: sourceResultId,
      });
      return { kind: "new", prepared: undefined };
    },
    effect: async () => {
      try {
        return (await perform(marker)) ? committed(beadId) : unknown(beadId);
      } catch (error) {
        if (
          error instanceof BeadsPreconditionFailed ||
          error instanceof BeadsNotStarted
        )
          return { status: "refused", beadId };
        return unknown(beadId);
      }
    },
    complete: (outcome) => {
      if (outcome.status === "committed")
        receiptsQueries.finish(db, owner, input.requestId, now());
      if (outcome.status === "refused")
        receiptsQueries.forgetPending(db, owner, input.requestId);
      return outcome;
    },
  });
}

export function createProjectBead(
  owner: string,
  project: string,
  body: BeadCreate,
) {
  const store = enabledStore(owner, project, body.storeId);
  let source =
    receiptsQueries.byRequest(db, owner, body.requestId)?.source_result_id ??
    null;
  if ((body.sourceResultId || body.sourceMessageId) && !source) {
    const result = body.sourceResultId
      ? resultsQueries.canonicalById(db, owner, body.sourceResultId)
      : resultsQueries.canonicalByMessage(db, owner, body.sourceMessageId!);
    if (!result || !resultBelongsTo(owner, project, result))
      throw new Problem(404, "Result not found in this project.");
    source = result.id;
  }
  const beadId = "loop-" + randomUUID().replaceAll("-", "");
  return mutate(
    owner,
    store,
    body,
    "create",
    beadId,
    source ?? null,
    async () =>
      nativeIssue.parse(
        await store.write([
          "create",
          "--id",
          beadId,
          "--title",
          body.title,
          "--description",
          body.description,
        ]),
      ).id === beadId,
    async (id) => (await issue(store, id)).id === id,
  );
}

export async function commentOnBead(
  owner: string,
  project: string,
  bead: string,
  body: BeadComment,
  authorName?: string,
) {
  const store = enabledStore(owner, project, body.storeId);
  if (!receiptsQueries.byRequest(db, owner, body.requestId)) {
    const target = await issue(store, bead);
    if (body.excerpt && !target.description.includes(body.excerpt))
      throw new Problem(409, "The selected passage changed. Select it again.");
  }
  const user = profilesQueries.profile(db, owner);
  const author =
    authorName || user?.display_name || user?.handle || "Loop user";
  const quote = body.excerpt
    ?.split("\n")
    .map((line) => "> " + line)
    .join("\n");
  const text = quote ? quote + "\n\n" + body.text : body.text;
  return mutate(
    owner,
    store,
    body,
    "comment",
    bead,
    null,
    async (marker) => {
      const annotated = text + "\n\n<!-- loop-comment:" + marker + " -->";
      const written = nativeComment.parse(
        await store.write([
          "comments",
          "add",
          bead,
          "--author",
          author,
          "--",
          annotated,
        ]),
      );
      return written.text.match(commentMarker)?.[1] === marker;
    },
    async (id, marker) => {
      const comments = await read(
        store,
        ["comments", id],
        z.array(nativeComment),
      );
      return (
        comments.filter(({ text }) => text.match(commentMarker)?.[1] === marker)
          .length === 1
      );
    },
  );
}

type Mutation = { storeId: string; requestId: string };

export async function linkBeadDependency(
  owner: string,
  project: string,
  bead: string,
  body: Mutation & { blocker: string },
) {
  const store = enabledStore(owner, project, body.storeId);
  if (bead === body.blocker)
    throw new Problem(400, "A bead cannot block itself.");
  const hasDependency = (result: Awaited<ReturnType<typeof issue>>) =>
    (result.dependencies ?? []).some(
      ({ depends_on_id, id }) => (depends_on_id ?? id) === body.blocker,
    );
  let alreadyLinked: boolean | undefined;
  if (!receiptsQueries.byRequest(db, owner, body.requestId)) {
    const blockers = await read(
      store,
      ["list", "--all", "--id", body.blocker],
      issueList,
    );
    if (!blockers.some(({ id }) => id === body.blocker))
      throw new Problem(404, "Blocking bead not found.");
    alreadyLinked = hasDependency(await issue(store, bead));
  }
  const dependencyStored = async () => hasDependency(await issue(store, bead));
  return mutate(
    owner,
    store,
    body,
    "dependency",
    bead,
    null,
    async () => {
      if (alreadyLinked === undefined) throw new BeadsPreconditionFailed();
      if (alreadyLinked) return true;
      await store.write(["dep", "add", bead, body.blocker, "--type", "blocks"]);
      return dependencyStored();
    },
    dependencyStored,
  );
}

export async function closeProjectBead(
  owner: string,
  project: string,
  bead: string,
  body: Mutation & { reason: string; generation: string | null },
  assignedRun?: string,
) {
  const store = enabledStore(owner, project, body.storeId);
  const active = assignmentsQueries.active(db, owner, store.id, bead);
  const previous = receiptsQueries.byRequest(db, owner, body.requestId);
  if (!previous && (active?.generation ?? null) !== body.generation)
    throw new Problem(409, "The assignment changed. Reopen the bead.");
  if (
    assignedRun &&
    (active?.run_id !== assignedRun || active.state !== "started")
  )
    throw new Problem(403, "An agent can only close its own assigned bead.");
  const current = previous ? undefined : await issue(store, bead);
  const recorded = async (id: string, marker: string) => {
    const current = await issue(store, id);
    return (
      current.status === "closed" &&
      current.close_reason?.match(closeMarker)?.[1] === marker
    );
  };
  return mutate(
    owner,
    store,
    body,
    "close",
    bead,
    null,
    async (marker) => {
      if (!current || current.status === "closed")
        throw new BeadsPreconditionFailed();
      const assignment = assignmentsQueries.active(db, owner, store.id, bead);
      if (
        (assignment?.generation ?? null) !== body.generation ||
        (assignment &&
          assignment.state !== "started" &&
          assignment.state !== "claimed")
      )
        throw new BeadsPreconditionFailed();
      if (
        assignment &&
        current.assignee !== "loop-start-" + assignment.generation
      )
        throw new BeadsPreconditionFailed();
      await store.write(
        [
          "--actor",
          current.assignee || "loop-owner",
          "close",
          bead,
          "--reason",
          body.reason + "\n\n<!-- loop-close:" + marker + " -->",
        ],
        {
          current: {
            id: bead,
            status: current.status,
            assignee: current.assignee || null,
          },
        },
      );
      return recorded(bead, marker);
    },
    recorded,
  );
}

function resultProject(owner: string, result: CanonicalResult) {
  const placement = result.provenance.placement;
  if (placement.projectId) return placement.projectId;
  const conversation = ownedConversation(
    result.provenance.conversationId,
    owner,
  );
  return foldersQueries.projectFor(db, {
    owner,
    folder: conversation.project_id,
  })?.id;
}

function resultBelongsTo(
  owner: string,
  project: string,
  result: CanonicalResult,
) {
  return resultProject(owner, result) === project;
}

export function resultWork(owner: string, message: string) {
  const result = resultsQueries.canonicalByMessage(db, owner, message);
  if (!result) return null;
  const projectId = resultProject(owner, result);
  if (!projectId || !foldersQueries.owned(db, projectId, owner)) return null;
  const binding = storesQueries.forProject(db, owner, projectId);
  if (!binding) return null;
  const assignment = result.provenance.runId
    ? assignmentsQueries.forRun(db, owner, result.provenance.runId)
    : undefined;
  return {
    projectId,
    beadId:
      assignment?.store_id === binding.store_id ? assignment.bead_id : null,
  };
}
