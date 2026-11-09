import * as agentActivitiesQueries from "./sql/agent-activities.js";
import * as conversationsQueries from "./sql/conversations.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar } from "./registrar.js";
import type { Run } from "./queue.js";

import { z } from "zod";
import { db, emit, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import {
  ACTIVITY_FEATURES,
  ACTIVITY_LIMITS,
  ACTIVITY_VERSION,
  activityKey,
  parseActivityUpdate,
  reduceActivity,
  type ActivityCapabilities,
  type ActivityRecord,
  type ActivityUpdate,
} from "../agent-activities.js";

// Server persistence and projection for shared agent activities. Every
// producer (API runtime, native adapters, ACP) calls `applyActivity` with a
// trusted scope; the update itself never chooses its owner, conversation or run.
type ActivityScope = {
  owner: string;
  conversation?: string | null;
  run?: string | null;
  // The producer's current process generation. Updates stamped with another
  // generation are stale and quarantined unless they are replayed history.
  generation?: string;
};
type ActivityResult =
  | { applied: true; key: string; sequence: number; record: ActivityRecord }
  | { applied: false; key?: string; reason: string };
type CapabilitiesResult =
  | { applied: true; key: string; sequence: number }
  | { applied: false; key?: string; reason: string };

type Row = {
  scope: string;
  activity_key: string;
  conversation_id: string | null;
  run_id: string | null;
  kind: string;
  record: string;
  sequence: number;
};

const scopeOf = (s: ActivityScope) =>
  s.conversation || (s.run ? "run:" + s.run : null);

function nextSequence(owner: string) {
  return (agentActivitiesQueries.maxSequence(db, owner) as { n: number }).n + 1;
}

function write(
  scope: ActivityScope,
  key: string,
  kind: ActivityUpdate["kind"] | "capabilities",
  record: unknown,
  session: boolean,
) {
  const sequence = nextSequence(scope.owner);
  agentActivitiesQueries.upsert(
    db,
    scope.owner,
    scopeOf(scope),
    key,
    scope.conversation || null,
    session ? null : scope.run || null,
    kind,
    JSON.stringify(record),
    sequence,
    now(),
    now(),
  );
  // Content-free refresh signal. Every client, including cached ones that do
  // not know activities, treats an unknown event as "refresh projections";
  // the record itself is only served by GET /conversations/:id/activities.
  emit(
    scope.owner,
    scope.run
      ? { kind: "run", id: scope.run }
      : { kind: "conversation", id: scope.conversation! },
    "activity.updated",
    { key, kind, sequence },
  );
  return sequence;
}

export function applyActivity(
  scope: ActivityScope,
  input: ActivityUpdate | unknown,
): ActivityResult {
  let update;
  try {
    update = parseActivityUpdate(input);
  } catch {
    return { applied: false, reason: "invalid activity update" };
  }
  if (!scopeOf(scope))
    return { applied: false, reason: "activity has no conversation or run" };
  if (
    scope.generation &&
    update.generation &&
    update.generation !== scope.generation &&
    !update.replay
  )
    return { applied: false, reason: "stale generation" };
  let key: string;
  try {
    // Replayed native history loaded outside a turn is keyed as history, so
    // stable native ids de-duplicate across reloads.
    key = activityKey(update, scope.run || (update.replay ? "history" : null));
  } catch (error) {
    return { applied: false, reason: (error as Error).message };
  }
  return db
    .transaction((): ActivityResult => {
      const row = agentActivitiesQueries.record(
        db,
        scope.owner,
        scopeOf(scope),
        key,
      ) as { record: string } | undefined;
      const stored = row
        ? (JSON.parse(row.record) as ActivityRecord)
        : undefined;
      if (stored && stored.kind !== update.kind)
        return { applied: false, key, reason: "activity kind mismatch" };
      const session = update.kind === "settings" || update.kind === "commands";
      // Producer revisions for settings/catalogs restart with each native
      // process. A new live generation's catalog is a complete replacement, so
      // the previous process's revision and options must not reject or leak
      // into it. The record revision stays monotonic for clients.
      const restarted =
        session &&
        stored &&
        !update.replay &&
        !!update.generation &&
        update.generation !== stored.generation;
      const previous = restarted ? undefined : stored;
      const result = reduceActivity(previous, update);
      if (!result.changed)
        return { applied: false, key, reason: result.reason };
      if (restarted) result.record.revision = stored.revision + 1;
      const sequence = write(scope, key, update.kind, result.record, session);
      return { applied: true, key, sequence, record: result.record };
    })
    .immediate();
}

// API-provider activities come from Loop's own broker and runtime, never from
// model prose. Display records must not fail a run, so rejections are dropped.
export function apiToolActivity(
  run: Run,
  callId: string,
  patch: Extract<ActivityUpdate, { kind: "tool" }>["patch"],
) {
  applyActivity(
    { owner: run.owner_id, conversation: run.conversation_id, run: run.id },
    {
      v: 1,
      kind: "tool",
      id: callId,
      source: { transport: "api", origin: "broker" },
      patch: { ...patch, links: { broker: callId, trace: "tool:" + callId } },
    },
  );
}

type NativeLive = {
  run?: {
    id: string;
    owner_id: string;
    conversation_id?: string | null;
  } | null;
  bootstrapRun?: { id: string; owner_id: string } | null;
  generation: string;
  binding: { conversation_id: string; harness?: string };
};

// Owner of a native conversation, checked against the run(s) the live
// session claims. A run bound to another conversation or owner is rejected.
function nativeOwner(live: NativeLive) {
  const owner = (
    conversationsQueries.owner(db, live.binding.conversation_id) as
      { owner_id: string } | undefined
  )?.owner_id;
  if (!owner) return;
  if (
    live.run &&
    (live.run.owner_id !== owner ||
      (live.run.conversation_id != null &&
        live.run.conversation_id !== live.binding.conversation_id))
  )
    return;
  if (live.bootstrapRun && live.bootstrapRun.owner_id !== owner) return;
  return owner;
}

// Native adapter entry point for AdapterEvent `{ type: "activity", activity }`.
// Identity comes from the server's live session, never from the adapter: the
// owning conversation, the current run (absent between turns) and the current
// process generation. Display records never interrupt native work, so
// invalid, oversized or stale updates are dropped here.
export function ingestNativeActivity(
  live: NativeLive,
  update: unknown,
): ActivityResult {
  if (
    Buffer.byteLength(JSON.stringify(update ?? null)) > ACTIVITY_LIMITS.ingest
  )
    return { applied: false, reason: "activity update too large" };
  const owner = nativeOwner(live);
  if (!owner) return { applied: false, reason: "unknown conversation" };
  return applyActivity(
    {
      owner,
      conversation: live.binding.conversation_id,
      run: live.run?.id,
      generation: live.generation,
    },
    update,
  );
}

const Capability = z
  .object({
    state: z.enum(["supported", "unsupported", "undiscovered"]),
    source: z.string().max(200),
    reason: z.string().max(2000).optional(),
  })
  .strict();
const Capabilities = z
  .object(
    Object.fromEntries(
      ACTIVITY_FEATURES.map((f) => [f, Capability.optional()]),
    ) as Record<
      (typeof ACTIVITY_FEATURES)[number],
      z.ZodOptional<typeof Capability>
    >,
  )
  .strip();

// Native `{ type: "activity_capabilities" }` entry point. Persisted per
// conversation with the reporting generation so a reload shows what the
// session last advertised and whether it came from the current process.
export function ingestNativeCapabilities(
  live: NativeLive,
  transport: "native" | "acp",
  input: unknown,
): CapabilitiesResult {
  const parsed = Capabilities.safeParse(input);
  if (!parsed.success)
    return { applied: false, reason: "invalid capabilities" };
  const owner = nativeOwner(live);
  if (!owner) return { applied: false, reason: "unknown conversation" };
  return setActivityCapabilities(
    {
      owner,
      conversation: live.binding.conversation_id,
      run: live.run?.id,
      generation: live.generation,
    },
    { transport, harness: live.binding.harness },
    parsed.data as Partial<ActivityCapabilities>,
  );
}

// Capabilities are replaced as a whole with their provenance. Unknown features
// are recorded as not yet discovered rather than silently supported.
export function setActivityCapabilities(
  scope: ActivityScope,
  source: { transport: string; harness?: string },
  capabilities: Partial<ActivityCapabilities>,
): CapabilitiesResult {
  if (!scopeOf(scope))
    return { applied: false, reason: "activity has no conversation or run" };
  const complete = Object.fromEntries(
    ACTIVITY_FEATURES.map((f) => [
      f,
      capabilities[f] || { state: "undiscovered", source: "loop" },
    ]),
  );
  const record = {
    v: ACTIVITY_VERSION,
    kind: "capabilities",
    source,
    ...(scope.generation && { generation: scope.generation }),
    capabilities: complete,
  };
  const key = `capabilities:${source.transport}:${source.harness || "default"}`;
  return db
    .transaction((): CapabilitiesResult => {
      const row = agentActivitiesQueries.record(
        db,
        scope.owner,
        scopeOf(scope),
        key,
      ) as { record: string } | undefined;
      if (row?.record === JSON.stringify(record))
        return { applied: false, key, reason: "no change" };
      const sequence = write(scope, key, "capabilities", record, true);
      return { applied: true, key, sequence };
    })
    .immediate();
}

const activityItem = (r: Row) => ({
  key: r.activity_key,
  kind: r.kind,
  run: r.run_id,
  sequence: r.sequence,
  record: JSON.parse(r.record),
});

export function listActivities(
  owner: string,
  conversation: string,
  options: {
    after?: number;
    run?: string;
    before?: number;
    view?: "recent" | "updates" | "files";
    tools?: "0" | "1";
    runs?: string[];
  } = {},
) {
  owned("conversations", conversation, owner);
  // Conversation chrome needs controls and file summaries, never tool history
  // Tool activity has its own lazy snapshot/cursor.
  if (
    options.tools === "0" &&
    (options.view === "recent" || options.view === "updates")
  ) {
    const initial = options.view === "recent";
    const rows = initial
      ? ["settings", "commands", "capabilities"].flatMap(
          (kind) =>
            agentActivitiesQueries.recentKind(
              db,
              owner,
              conversation,
              kind,
            ) as Row[],
        )
      : (agentActivitiesQueries.controlUpdates(
          db,
          owner,
          conversation,
          options.after ?? 0,
        ) as Row[]);
    const more = !initial && rows.length > 500;
    if (more) rows.pop();
    const cursor = initial
      ? ((
          agentActivitiesQueries.cursor(db, owner, conversation) as {
            cursor: number | null;
          }
        ).cursor ?? 0)
      : (rows.at(-1)?.sequence ?? options.after ?? 0);
    return {
      version: ACTIVITY_VERSION,
      items: rows.map(activityItem),
      cursor,
      more,
      earlier: null,
    };
  }
  if (options.view === "recent") {
    const rows = agentActivitiesQueries.before(
      db,
      owner,
      conversation,
      options.before ?? Number.MAX_SAFE_INTEGER,
    ) as Row[];
    const more = rows.length > 100;
    if (more) rows.pop();
    const next = more ? rows.at(-1)!.sequence : null;
    // Only offer older activity this view can show. File changes load with
    // their run and controls come with the snapshot, so pages holding nothing
    // else would ask the reader to load records that never appear.
    const earlier =
      next !== null &&
      agentActivitiesQueries.hasEarlierTools(db, owner, conversation, next)
        ? next
        : null;
    // Controls are keyed by producer, not turn. Include their current records
    // even if hundreds of newer tool updates put them outside the recent page.
    const controls =
      options.before === undefined
        ? ["settings", "commands", "capabilities"].flatMap(
            (kind) =>
              agentActivitiesQueries.recentKind(
                db,
                owner,
                conversation,
                kind,
              ) as Row[],
          )
        : [];
    const byKey = new Map(
      [...rows, ...controls].map((r) => [r.activity_key, r]),
    );
    return {
      version: ACTIVITY_VERSION,
      items: [...byKey.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(activityItem),
      cursor: rows[0]?.sequence ?? 0,
      more: false,
      earlier,
    };
  }
  if (options.view === "files") {
    const runs = options.runs || [];
    if (!runs.length) throw new Problem(400, "Choose runs for file changes");
    const rows = agentActivitiesQueries.fileUpdates(
      db,
      owner,
      conversation,
      runs,
      options.after ?? 0,
    ) as Row[];
    const more = rows.length > 500;
    if (more) rows.pop();
    return {
      version: ACTIVITY_VERSION,
      items: rows.map(activityItem),
      cursor: rows.at(-1)?.sequence ?? options.after ?? 0,
      more,
    };
  }
  const rows = agentActivitiesQueries.updates(
    db,
    owner,
    conversation,
    options.after || 0,
    options.run || null,
  ) as Row[];
  const more = rows.length > 500;
  if (more) rows.pop();
  const items = rows.map(activityItem);
  return {
    version: ACTIVITY_VERSION,
    items,
    cursor: items.at(-1)?.sequence ?? options.after ?? 0,
    more,
  };
}

const routes = registrar("activityRoutes");
export const activityRoutes = routes.mount;
routes.on(workspaceApi.conversationActivities, (req, res) => {
  res.json(
    listActivities(res.locals.owner, req.params.id, {
      ...req.query,
      runs: req.query.runs?.split(","),
    }) as z.input<typeof workspaceApi.conversationActivities.response>,
  );
});
