import { Router } from "express";
import { z } from "zod";
import { db, emit, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import { publicTraceFilter } from "./traces.js";
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
export type ActivityScope = {
  owner: string;
  conversation?: string | null;
  run?: string | null;
  // The producer's current process generation. Updates stamped with another
  // generation are stale and quarantined unless they are replayed history.
  generation?: string;
  // Run that carries the refresh signal for session records written between
  // turns (the run that started the native session). Never stored as owner.
  signal?: string;
};
export type ActivityResult =
  | { applied: true; key: string; sequence: number; record: ActivityRecord }
  | { applied: false; key?: string; reason: string };
export type CapabilitiesResult =
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
  return (
    (
      db
        .prepare(
          "SELECT coalesce(max(sequence),0) n FROM agent_activities WHERE owner_id=?",
        )
        .get(owner) as { n: number }
    ).n + 1
  );
}

function write(
  scope: ActivityScope,
  key: string,
  kind: ActivityUpdate["kind"] | "capabilities",
  record: unknown,
  session: boolean,
) {
  const sequence = nextSequence(scope.owner);
  db.prepare(
    `INSERT INTO agent_activities(owner_id,scope,activity_key,conversation_id,run_id,kind,record,sequence,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,scope,activity_key) DO UPDATE SET
    record=excluded.record,sequence=excluded.sequence,updated_at=excluded.updated_at`,
  ).run(
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
  const signal = scope.run || scope.signal;
  if (signal)
    emit(scope.owner, signal, "activity.updated", { key, kind, sequence });
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
      const row = db
        .prepare(
          "SELECT record FROM agent_activities WHERE owner_id=? AND scope=? AND activity_key=?",
        )
        .get(scope.owner, scopeOf(scope), key) as { record: string } | undefined;
      const stored = row ? (JSON.parse(row.record) as ActivityRecord) : undefined;
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
      if (!result.changed) return { applied: false, key, reason: result.reason };
      if (restarted) result.record.revision = stored.revision + 1;
      const sequence = write(scope, key, update.kind, result.record, session);
      return { applied: true, key, sequence, record: result.record };
    })
    .immediate();
}

type NativeLive = {
  run?: { id: string; owner_id: string; conversation_id?: string | null } | null;
  bootstrapRun?: { id: string; owner_id: string } | null;
  generation: string;
  binding: { conversation_id: string; harness?: string };
};

// Owner of a native conversation, checked against the run(s) the live
// session claims. A run bound to another conversation or owner is rejected.
function nativeOwner(live: NativeLive) {
  const owner = (
    db
      .prepare("SELECT owner_id FROM conversations WHERE id=?")
      .get(live.binding.conversation_id) as { owner_id: string } | undefined
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
  if (Buffer.byteLength(JSON.stringify(update ?? null)) > ACTIVITY_LIMITS.ingest)
    return { applied: false, reason: "activity update too large" };
  const owner = nativeOwner(live);
  if (!owner) return { applied: false, reason: "unknown conversation" };
  return applyActivity(
    {
      owner,
      conversation: live.binding.conversation_id,
      run: live.run?.id,
      generation: live.generation,
      signal: live.bootstrapRun?.id,
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
    ) as Record<(typeof ACTIVITY_FEATURES)[number], z.ZodOptional<typeof Capability>>,
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
  if (!parsed.success) return { applied: false, reason: "invalid capabilities" };
  const owner = nativeOwner(live);
  if (!owner) return { applied: false, reason: "unknown conversation" };
  return setActivityCapabilities(
    {
      owner,
      conversation: live.binding.conversation_id,
      generation: live.generation,
      signal: live.run?.id || live.bootstrapRun?.id,
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
      const row = db
        .prepare(
          "SELECT record FROM agent_activities WHERE owner_id=? AND scope=? AND activity_key=?",
        )
        .get(scope.owner, scopeOf(scope), key) as { record: string } | undefined;
      if (row?.record === JSON.stringify(record))
        return { applied: false, key, reason: "no change" };
      const sequence = write(scope, key, "capabilities", record, true);
      return { applied: true, key, sequence };
    })
    .immediate();
}

// Old runs predate activities. Project only their public broker/native tool
// traces as read-only records; internal envelopes stay hidden as in agentTraces.
// Paged legacy history must not offer traces already represented by a durable
// record, even when that record is on an older activity page.
const unrepresentedTrace = `NOT EXISTS (
  SELECT 1 FROM agent_activities a
  WHERE a.owner_id=t.owner_id AND a.scope=COALESCE(r.conversation_id,'run:'||r.id)
    AND a.run_id=t.run_id AND json_extract(a.record,'$.data.links.trace') IS NOT NULL
    AND json_extract(a.record,'$.data.links.trace')=t.trace_key
)`;

function legacyTools(
  owner: string,
  scope: string,
  known: Set<string>,
  before?: number,
) {
  const traces = db
    .prepare(
      `SELECT t.run_id,t.trace_key,t.title,t.content,t.metadata,t.artifact_id,t.id
      FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
      WHERE t.owner_id=? AND t.kind='tool' AND (r.conversation_id=? OR 'run:'||r.id=?)
        -- Plan tool calls are represented by their plan activity.
        AND t.title<>'loop_plan'
        AND ${publicTraceFilter}
        ${before === undefined ? "" : `AND ${unrepresentedTrace}`}
      AND t.id<? ORDER BY t.id ${before === undefined ? "ASC" : "DESC"} LIMIT ?`,
    )
    .all(
      owner,
      scope,
      scope,
      before ?? Number.MAX_SAFE_INTEGER,
      before === undefined ? 2000 : 101,
    ) as any[];
  const more = before !== undefined && traces.length > 100;
  if (more) traces.pop();
  const next = more ? (traces.at(-1)!.id as number) : null;
  const items = traces
    .filter((t) => !known.has(t.run_id + "\0" + t.trace_key))
    .map((t) => {
      const metadata = JSON.parse(t.metadata || "{}");
      const state = String(metadata.state || metadata.status || "");
      const status = ["running", "waiting", "completed", "failed"].includes(
        state,
      )
        ? state
        : metadata.isError
          ? "failed"
          : "unknown";
      const record = {
        v: ACTIVITY_VERSION,
        kind: "tool",
        id: t.trace_key,
        source: {
          transport: metadata.native ? "native" : "api",
          origin: "trace",
        },
        revision: 1,
        fieldSeq: {},
        partial: false,
        replayed: true,
        data: {
          title: t.title,
          status,
          content: [
            ...(t.content
              ? [{ type: "text", text: String(t.content).slice(0, 16000) }]
              : []),
            ...(t.artifact_id
              ? [{ type: "artifact", artifactId: t.artifact_id }]
              : []),
          ],
          links: { trace: t.trace_key },
        },
      };
      return {
        key: `tool:legacy:trace:${t.run_id}:${t.trace_key}`,
        kind: "tool",
        run: t.run_id as string,
        sequence: 0,
        legacy: true,
        record,
      };
    });
  return { items, next };
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
    view?: "recent" | "updates" | "legacy" | "files";
    tools?: "0" | "1";
    runs?: string[];
  } = {},
) {
  owned("conversations", conversation, owner);
  // Conversation chrome needs controls and file summaries, never tool history
  // or legacy trace discovery. Tool activity has its own lazy snapshot/cursor.
  if (
    options.tools === "0" &&
    (options.view === "recent" || options.view === "updates")
  ) {
    const initial = options.view === "recent";
    const rows = initial
      ? ["settings", "commands", "capabilities"].flatMap(
          (kind) =>
            db
              .prepare(
                `SELECT * FROM agent_activities WHERE owner_id=? AND scope=? AND kind=?
           ORDER BY sequence DESC LIMIT 16`,
              )
              .all(owner, conversation, kind) as Row[],
        )
      : (db
          .prepare(
            `SELECT * FROM agent_activities WHERE owner_id=? AND scope=?
          AND kind IN ('settings','commands','capabilities','file_change') AND sequence>?
          ORDER BY sequence LIMIT 501`,
          )
          .all(owner, conversation, options.after ?? 0) as Row[]);
    const more = !initial && rows.length > 500;
    if (more) rows.pop();
    const cursor = initial
      ? ((
          db
            .prepare(
              "SELECT max(sequence) cursor FROM agent_activities WHERE owner_id=? AND scope=?",
            )
            .get(owner, conversation) as { cursor: number | null }
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
  if (options.view === "legacy") {
    const page = legacyTools(
      owner,
      conversation,
      new Set(),
      options.before ?? Number.MAX_SAFE_INTEGER,
    );
    return {
      version: ACTIVITY_VERSION,
      items: page.items,
      cursor: 0,
      more: false,
      earlier: page.next,
    };
  }
  if (options.view === "recent") {
    const rows = db
      .prepare(
        `SELECT * FROM agent_activities
      WHERE owner_id=? AND scope=? AND sequence<? ORDER BY sequence DESC LIMIT 101`,
      )
      .all(
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
      db
        .prepare(
          `SELECT 1 FROM agent_activities WHERE owner_id=? AND scope=?
      AND kind IN ('tool','output','plan') AND sequence<? LIMIT 1`,
        )
        .get(owner, conversation, next)
        ? next
        : null;
    // Controls are keyed by producer, not turn. Include their current records
    // even if hundreds of newer tool updates put them outside the recent page.
    const controls =
      options.before === undefined
        ? ["settings", "commands", "capabilities"].flatMap(
            (kind) =>
              db
                .prepare(
                  `SELECT * FROM agent_activities WHERE owner_id=? AND scope=? AND kind=?
        ORDER BY sequence DESC LIMIT 16`,
                )
                .all(owner, conversation, kind) as Row[],
          )
        : [];
    const byKey = new Map(
      [...rows, ...controls].map((r) => [r.activity_key, r]),
    );
    // Match legacyTools exactly: traces it hides as internal envelopes or as
    // plan calls are not history the reader can load.
    const legacyAvailable =
      options.before === undefined &&
      !!db
        .prepare(
          `SELECT 1 FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
      WHERE t.owner_id=? AND t.kind='tool' AND (r.conversation_id=? OR 'run:'||r.id=?)
        AND t.title<>'loop_plan' AND ${publicTraceFilter}
        AND ${unrepresentedTrace} LIMIT 1`,
        )
        .get(owner, conversation, conversation);
    return {
      version: ACTIVITY_VERSION,
      items: [...byKey.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(activityItem),
      cursor: rows[0]?.sequence ?? 0,
      more: false,
      earlier,
      legacyAvailable,
    };
  }
  if (options.view === "files") {
    const runs = options.runs || [];
    if (!runs.length) throw new Problem(400, "Choose runs for file changes");
    const rows = db
      .prepare(
        `SELECT * FROM agent_activities WHERE owner_id=? AND scope=?
      AND run_id IN (${runs.map(() => "?").join(",")}) AND kind='file_change' AND sequence>?
      ORDER BY sequence LIMIT 501`,
      )
      .all(owner, conversation, ...runs, options.after ?? 0) as Row[];
    const more = rows.length > 500;
    if (more) rows.pop();
    return {
      version: ACTIVITY_VERSION,
      items: rows.map(activityItem),
      cursor: rows.at(-1)?.sequence ?? options.after ?? 0,
      more,
    };
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_activities WHERE owner_id=? AND scope=? AND sequence>?
      AND (? IS NULL OR run_id IS NULL OR run_id=?) ORDER BY sequence LIMIT 501`,
    )
    .all(
      owner,
      conversation,
      options.after || 0,
      options.run || null,
      options.run || null,
    ) as Row[];
  const more = rows.length > 500;
  if (more) rows.pop();
  const items = rows.map(activityItem);
  // Legacy records are only needed for a full (non-incremental) load.
  const known = new Set<string>();
  for (const item of items) {
    const trace = item.record?.data?.links?.trace;
    if (item.run && trace) known.add(item.run + "\0" + trace);
  }
  const legacy =
    options.after !== undefined || options.view
      ? []
      : legacyTools(owner, conversation, known).items.filter(
          (l) => !options.run || l.run === options.run,
        );
  return {
    version: ACTIVITY_VERSION,
    items: [...legacy, ...items],
    cursor: items.at(-1)?.sequence ?? options.after ?? 0,
    more,
  };
}

export const activityRoutes = Router();
activityRoutes.get("/conversations/:id/activities", (req, res) => {
  const query = z
    .object({
      after: z.coerce.number().int().nonnegative().optional(),
      run: z.string().max(100).optional(),
      before: z.coerce
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      view: z.enum(["recent", "updates", "legacy", "files"]).optional(),
      tools: z.enum(["0", "1"]).optional(),
      runs: z
        .string()
        .max(7600)
        .transform((value) => value.split(","))
        .pipe(z.array(z.string().min(1).max(150)).min(1).max(50))
        .optional(),
    })
    .safeParse(req.query);
  if (!query.success) throw new Problem(400, "Invalid activity query");
  res.json(listActivities(res.locals.owner, String(req.params.id), query.data));
});
