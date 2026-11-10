import { z } from "zod";

// Shared agent activities: one versioned display model for native harnesses,
// the API-provider runtime and ACP. Producers send partial `ActivityUpdate`s;
// every consumer (live events, snapshots, replay, persistence) folds them with
// the same `reduceActivity`, so refresh and history reconstruct identical
// records. Activities are display data only: receiving a diff never applies
// it, and receiving a setting never makes it effective until confirmed.
//
// Field semantics for every patch: an absent field keeps the previous value,
// `null` clears an optional value, and any other value replaces it.

export const ACTIVITY_VERSION = 1;
// Activity changes publish content-free refresh signals; clients read the
// current records through the conversation activities projection.

export const ACTIVITY_LIMITS = {
  id: 300,
  title: 500,
  text: 16_000,
  steps: 100,
  tools: 64,
  toolInput: 16_000,
  toolContent: 32,
  files: 200,
  path: 4096,
  // Per file change record, summed over patch/before/after text.
  diffBytes: 256 * 1024,
  // Retained command output per record; older output is dropped first.
  outputBytes: 64 * 1024,
  outputChunk: 64 * 1024,
  // Out-of-order chunks held for a gap before the earliest is given up on.
  outputPending: 64,
  settings: 50,
  choices: 100,
  commands: 500,
  record: 512 * 1024,
  // Serialized size of one incoming update before validation.
  ingest: 1024 * 1024,
} as const;

export const ActivityKind = z.enum([
  "plan",
  "tool",
  "file_change",
  "output",
  "settings",
  "commands",
]);
export type ActivityKind = z.infer<typeof ActivityKind>;
// Settings and command catalogs describe the session; the rest belong to a turn.
export const SESSION_KINDS: readonly ActivityKind[] = ["settings", "commands"];

const Id = z.string().min(1).max(ACTIVITY_LIMITS.id);
const Text = z.string().max(ACTIVITY_LIMITS.text);
const Path = z.string().min(1).max(ACTIVITY_LIMITS.path);

const ActivitySource = z
  .object({
    // How Loop reached the harness. Independent of model provider/account.
    transport: z.enum(["native", "api", "acp"]),
    // Harness identity, e.g. "codex" or a configured ACP agent id.
    harness: z.string().max(200).optional(),
    // Producer inside Loop, e.g. "broker", "loop_plan", "codex:item", "acp".
    origin: z.string().min(1).max(100),
  })
  .strict();
type ActivitySource = z.infer<typeof ActivitySource>;

// ---- Plans --------------------------------------------------------------
const PlanStepStatus = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
const PlanStep = z
  .object({
    // Stable when the producer supplies one. Otherwise `step-<index>` with
    // `positional: true`; never derived from the step text.
    id: Id,
    positional: z.boolean().optional(),
    title: z
      .string()
      .min(1)
      .max(ACTIVITY_LIMITS.title * 4),
    status: PlanStepStatus,
    priority: z.enum(["high", "medium", "low"]).optional(),
  })
  .strict();
type PlanStep = z.infer<typeof PlanStep>;
const PlanPatch = z
  .object({
    // Plans are replaced as a whole list, matching ACP/Codex semantics.
    steps: z.array(PlanStep).max(ACTIVITY_LIMITS.steps).optional(),
    explanation: Text.nullable().optional(),
  })
  .strict();
type PlanData = {
  steps: PlanStep[];
  explanation?: string;
  // Increments whenever the step list is replaced.
  revision: number;
};

// ---- Tools --------------------------------------------------------------
const ToolStatus = z.enum([
  "proposed", // requested, not yet authorized or started
  "waiting", // waiting for approval or child work
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown", // dispatch outcome uncertain; never automatically replayed
]);
type ToolStatus = z.infer<typeof ToolStatus>;
const ToolContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: Text }).strict(),
  z.object({ type: z.literal("file_change"), activity: Id }).strict(),
  z.object({ type: z.literal("output"), activity: Id }).strict(),
  z
    .object({
      type: z.literal("artifact"),
      artifactId: z.string().max(100),
      title: z.string().max(ACTIVITY_LIMITS.title).optional(),
    })
    .strict(),
  // An unavailable reference (e.g. an ACP terminal Loop cannot host).
  z
    .object({
      type: z.literal("unavailable"),
      label: z.string().max(ACTIVITY_LIMITS.title),
      reason: z.string().max(1000),
    })
    .strict(),
]);
type ToolContent = z.infer<typeof ToolContent>;
const ToolPatch = z
  .object({
    title: z.string().max(ACTIVITY_LIMITS.title).nullable().optional(),
    // Protocol tool category ("read", "edit", "execute", "fetch", ...).
    category: z.string().max(40).nullable().optional(),
    status: ToolStatus.optional(),
    input: z.string().max(ACTIVITY_LIMITS.toolInput).nullable().optional(),
    // Replaces the previous content list when present.
    content: z.array(ToolContent).max(ACTIVITY_LIMITS.toolContent).optional(),
    error: Text.nullable().optional(),
    locations: z.array(Path).max(ACTIVITY_LIMITS.files).nullable().optional(),
    // Invocation identities for de-duplication with broker/native records.
    links: z
      .object({
        broker: Id.optional(),
        // Native trace identities are bounded by the incoming event, not the
        // activity ID cap. Preserve the exact link; never truncate identity.
        trace: z.string().max(ACTIVITY_LIMITS.record).optional(),
        native: Id.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type ToolData = {
  title?: string;
  category?: string;
  status: ToolStatus;
  input?: string;
  content: ToolContent[];
  error?: string;
  locations?: string[];
  links: { broker?: string; trace?: string; native?: string };
};

// ---- File changes -------------------------------------------------------
const FileEntry = z
  .object({
    path: Path,
    oldPath: Path.optional(),
    operation: z.enum(["create", "modify", "delete", "rename"]),
    // Prefer a unified patch; before/after when that is what the source reports.
    patch: z.string().optional(),
    before: z.string().nullable().optional(),
    after: z.string().nullable().optional(),
    content: z
      .enum(["available", "binary", "oversized", "unavailable"])
      .default("available"),
    reason: z.string().max(1000).optional(),
  })
  .strict();
type FileEntry = z.infer<typeof FileEntry>;
const FileChangePatch = z
  .object({
    tool: Id.nullable().optional(),
    // Display state only. Receiving a diff never applies it.
    state: z.enum(["proposed", "applied", "failed", "unknown"]).optional(),
    // Replaces the full change set when present.
    files: z.array(FileEntry).max(ACTIVITY_LIMITS.files).optional(),
  })
  .strict();
export type FileChangeData = {
  tool?: string;
  state: "proposed" | "applied" | "failed" | "unknown";
  files: FileEntry[];
};

// ---- Command output -----------------------------------------------------
const OutputChunk = z
  .object({
    stream: z.enum(["stdout", "stderr", "combined"]),
    text: z.string().max(ACTIVITY_LIMITS.outputChunk),
    // Producer chunk order. Without it chunks are appended in arrival order.
    index: z.number().int().nonnegative().optional(),
  })
  .strict();
const OutputPatch = z
  .object({
    tool: Id.nullable().optional(),
    terminal: z.string().max(ACTIVITY_LIMITS.id).nullable().optional(),
    command: Text.nullable().optional(),
    cwd: Path.nullable().optional(),
    append: z.array(OutputChunk).max(256).optional(),
    // Final bounded output when a source cannot stream; replaces chunks.
    replace: z.array(OutputChunk).max(256).optional(),
    status: z.enum(["running", "exited", "failed", "unknown"]).optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().max(40).nullable().optional(),
    // Output a source could not deliver (e.g. an ACP terminal Loop does not host).
    unavailable: z.string().max(1000).nullable().optional(),
    // The source itself dropped output before Loop received it.
    upstreamTruncated: z.boolean().optional(),
  })
  .strict();
export type OutputData = {
  tool?: string;
  terminal?: string;
  command?: string;
  cwd?: string;
  chunks: {
    stream: "stdout" | "stderr" | "combined";
    text: string;
    index: number;
  }[];
  // Separate streams unless a source only reports combined output.
  streams: "separate" | "combined";
  status: "running" | "exited" | "failed" | "unknown";
  exitCode?: number;
  signal?: string;
  unavailable?: string;
  // Loop's own retention drops (droppedBytes/Chunks, below `floor`) and
  // whether the source reported truncating output before delivery.
  truncated: {
    droppedBytes: number;
    droppedChunks: number;
    floor: number;
    upstream?: boolean;
  };
  nextIndex: number;
  pending: {
    stream: "stdout" | "stderr" | "combined";
    text: string;
    index: number;
  }[];
};

// ---- Session settings ---------------------------------------------------
const SettingValue = z.union([z.string().max(1000), z.boolean(), z.number()]);
export type SettingValue = z.infer<typeof SettingValue>;
const Setting = z
  .object({
    id: Id,
    label: z.string().max(ACTIVITY_LIMITS.title).optional(),
    description: z.string().max(2000).nullable().optional(),
    type: z.enum(["select", "boolean", "text"]).optional(),
    choices: z
      .array(
        z
          .object({
            value: z.string().max(1000),
            label: z.string().max(ACTIVITY_LIMITS.title),
            description: z.string().max(1000).optional(),
          })
          .strict(),
      )
      .max(ACTIVITY_LIMITS.choices)
      .nullable()
      .optional(),
    // The authoritative runtime confirmed this value. Never set from a request.
    confirmed: SettingValue.nullable().optional(),
    // A value Loop asked for that the runtime has not yet confirmed or rejected.
    requested: SettingValue.nullable().optional(),
    rejected: z.string().max(1000).nullable().optional(),
    application: z.enum(["live", "next-turn", "new-session"]).optional(),
    mutable: z.boolean().optional(),
    reason: z.string().max(1000).nullable().optional(),
    provenance: z.string().max(100).optional(),
  })
  .strict();
export type Setting = z.infer<typeof Setting>;
const SettingsPatch = z
  .object({
    // Upsert by id; each option merges field-by-field.
    options: z.array(Setting).max(ACTIVITY_LIMITS.settings).optional(),
    remove: z.array(Id).max(ACTIVITY_LIMITS.settings).optional(),
    // Producer revision; older revisions are ignored.
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SettingsData = {
  options: Setting[];
  revision: number;
};

// ---- Command catalogs ---------------------------------------------------
const CatalogCommand = z
  .object({
    id: Id,
    token: z.string().min(1).max(200),
    name: z.string().max(200),
    description: z.string().max(2000).default(""),
    argumentHint: z.string().max(500).optional(),
    kind: z.string().max(40).optional(),
    available: z.boolean().default(true),
    reason: z.string().max(1000).optional(),
  })
  .strict();
type CatalogCommand = z.infer<typeof CatalogCommand>;
const CommandsPatch = z
  .object({
    // Always the complete catalog, so removals are explicit.
    commands: z.array(CatalogCommand).max(ACTIVITY_LIMITS.commands),
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CommandsData = { commands: CatalogCommand[]; revision: number };

// ---- Updates and records -----------------------------------------------
const base = {
  v: z.literal(ACTIVITY_VERSION),
  id: Id,
  source: ActivitySource,
  // Producer process generation. Ingestion rejects non-current generations.
  generation: z.string().max(200).optional(),
  // Monotonic per (generation, activity). Enables duplicate/out-of-order handling.
  seq: z.number().int().nonnegative().optional(),
  // Native history hydration: display-only, never regresses newer state.
  replay: z.boolean().optional(),
};
export const ActivityUpdate = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("plan"), patch: PlanPatch }).strict(),
  z.object({ ...base, kind: z.literal("tool"), patch: ToolPatch }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("file_change"),
      patch: FileChangePatch,
    })
    .strict(),
  z.object({ ...base, kind: z.literal("output"), patch: OutputPatch }).strict(),
  z
    .object({ ...base, kind: z.literal("settings"), patch: SettingsPatch })
    .strict(),
  z
    .object({ ...base, kind: z.literal("commands"), patch: CommandsPatch })
    .strict(),
]);
export type ActivityUpdate = z.input<typeof ActivityUpdate>;
// Adapter event carrying a shared update; a member of `AdapterEvent` in
// protocol.ts. The server supplies conversation, run, owner and the current
// process generation from the live session (NativeSessions.activity ->
// ingestNativeActivity). Browser events announce changes without the payload.
export type ActivityEvent = { type: "activity"; activity: ActivityUpdate };
type ParsedUpdate = z.output<typeof ActivityUpdate>;

type DataFor = {
  plan: PlanData;
  tool: ToolData;
  file_change: FileChangeData;
  output: OutputData;
  settings: SettingsData;
  commands: CommandsData;
};
export type ActivityRecord<K extends ActivityKind = ActivityKind> = {
  [P in K]: {
    v: typeof ACTIVITY_VERSION;
    kind: P;
    id: string;
    source: ActivitySource;
    generation?: string;
    // Accepted update count; increases on every effective change.
    revision: number;
    // Highest producer seq applied per field, for out-of-order merging.
    fieldSeq: Record<string, number>;
    // Created by an update that arrived before the producer's initial record.
    partial: boolean;
    // True while the record only reflects replayed native history.
    replayed: boolean;
    data: DataFor[P];
  };
}[K];

// Public, reduced records reuse the ingest field schemas, without applying
// per-update array limits to catalogs accumulated across several updates.
const retained = <T extends z.ZodType>(
  field: z.ZodOptional<z.ZodNullable<T>>,
) => field.unwrap().unwrap().optional();
const recordedChunk = OutputChunk.strip().required({ index: true });
const recordBase = {
  v: z.literal(ACTIVITY_VERSION),
  id: z.string(),
  source: ActivitySource.strip(),
  generation: base.generation,
  revision: z.number(),
  fieldSeq: z.record(z.string(), z.number()),
  partial: z.boolean(),
  replayed: z.boolean(),
};
export const ActivityRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...recordBase,
    kind: z.literal("plan"),
    data: z.object({
      steps: z.array(PlanStep.strip()),
      explanation: retained(PlanPatch.shape.explanation),
      revision: z.number(),
    }),
  }),
  z.object({
    ...recordBase,
    kind: z.literal("tool"),
    data: z.object({
      title: retained(ToolPatch.shape.title),
      category: retained(ToolPatch.shape.category),
      status: ToolStatus,
      input: retained(ToolPatch.shape.input),
      content: z.array(
        z.discriminatedUnion("type", [
          ToolContent.options[0].strip(),
          ToolContent.options[1].strip(),
          ToolContent.options[2].strip(),
          ToolContent.options[3].strip(),
          ToolContent.options[4].strip(),
        ]),
      ),
      error: retained(ToolPatch.shape.error),
      locations: retained(ToolPatch.shape.locations),
      links: ToolPatch.shape.links.unwrap().strip(),
    }),
  }),
  z.object({
    ...recordBase,
    kind: z.literal("file_change"),
    data: z.object({
      tool: retained(FileChangePatch.shape.tool),
      state: FileChangePatch.shape.state.unwrap(),
      files: z.array(
        FileEntry.strip().extend({ content: FileEntry.shape.content.unwrap() }),
      ),
    }),
  }),
  z.object({
    ...recordBase,
    kind: z.literal("output"),
    data: z.object({
      tool: retained(OutputPatch.shape.tool),
      terminal: retained(OutputPatch.shape.terminal),
      command: retained(OutputPatch.shape.command),
      cwd: retained(OutputPatch.shape.cwd),
      chunks: z.array(recordedChunk),
      streams: z.enum(["separate", "combined"]),
      status: OutputPatch.shape.status.unwrap(),
      exitCode: retained(OutputPatch.shape.exitCode),
      signal: retained(OutputPatch.shape.signal),
      unavailable: retained(OutputPatch.shape.unavailable),
      truncated: z.object({
        droppedBytes: z.number(),
        droppedChunks: z.number(),
        floor: z.number(),
        upstream: z.boolean().optional(),
      }),
      nextIndex: z.number(),
      pending: z.array(recordedChunk),
    }),
  }),
  z.object({
    ...recordBase,
    kind: z.literal("settings"),
    data: z.object({
      options: z.array(
        Setting.strip().extend({
          choices: Setting.shape.choices
            .unwrap()
            .unwrap()
            .element.strip()
            .array()
            .nullable()
            .optional(),
        }),
      ),
      revision: z.number(),
    }),
  }),
  z.object({
    ...recordBase,
    kind: z.literal("commands"),
    data: z.object({
      // Defaults belong to ingestion, never to a fetched display record.
      commands: z.array(
        CatalogCommand.strip().extend({
          description: CatalogCommand.shape.description.unwrap(),
          available: CatalogCommand.shape.available.unwrap(),
        }),
      ),
      revision: z.number(),
    }),
  }),
]) satisfies z.ZodType<ActivityRecord>;

type ActivityCapabilityState = "supported" | "unsupported" | "undiscovered";
type ActivityCapability = {
  state: ActivityCapabilityState;
  // Where this answer came from: "loop", "codex app-server 0.x", "acp initialize", ...
  source: string;
  reason?: string;
};
export const ACTIVITY_FEATURES = [
  "plans",
  "tools",
  "diffs",
  "output",
  "settings",
  "commands",
] as const;
type ActivityFeature = (typeof ACTIVITY_FEATURES)[number];
export type ActivityCapabilities = Record<ActivityFeature, ActivityCapability>;
export function undiscoveredCapabilities(source: string): ActivityCapabilities {
  return Object.fromEntries(
    ACTIVITY_FEATURES.map((f) => [f, { state: "undiscovered", source }]),
  ) as ActivityCapabilities;
}

// Stable identity within a conversation (session kinds) or a turn (the rest).
// Callers supply the turn from trusted server context, never from the update.
export function activityKey(
  update: Pick<ActivityUpdate, "kind" | "id" | "source">,
  turn?: string | null,
) {
  const session = SESSION_KINDS.includes(update.kind);
  if (!session && !turn) throw new Error("Turn activities require a turn.");
  return activityRecordKey(update, turn);
}

// Presentation can include runless history; ingest still requires a turn above.
export function activityRecordKey(
  update: Pick<ActivityUpdate, "kind" | "id" | "source">,
  turn?: string | null,
) {
  return [
    update.kind,
    update.source.transport,
    update.source.origin,
    SESSION_KINDS.includes(update.kind) ? "session" : turn,
    update.id,
  ].join(":");
}

export function parseActivityUpdate(input: unknown): ParsedUpdate {
  return ActivityUpdate.parse(input);
}

const TOOL_RANK: Record<ToolStatus, number> = {
  proposed: 0,
  waiting: 1,
  running: 1,
  unknown: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
};
const OUTPUT_RANK = { running: 0, unknown: 1, exited: 2, failed: 2 } as const;
const FILE_RANK = { proposed: 0, unknown: 1, applied: 2, failed: 2 } as const;

function empty(kind: ActivityKind): DataFor[ActivityKind] {
  switch (kind) {
    case "plan":
      return { steps: [], revision: 0 };
    case "tool":
      return { status: "proposed", content: [], links: {} };
    case "file_change":
      return { state: "proposed", files: [] };
    case "output":
      return {
        chunks: [],
        streams: "separate",
        status: "running",
        truncated: { droppedBytes: 0, droppedChunks: 0, floor: 0 },
        nextIndex: 0,
        pending: [],
      };
    case "settings":
      return { options: [], revision: 0 };
    case "commands":
      return { commands: [], revision: 0 };
  }
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;
function clip(text: string, max: number) {
  if (bytes(text) <= max) return text;
  // Trim by bytes without splitting a UTF-16 surrogate pair.
  let out = text.slice(0, max);
  while (bytes(out) > max)
    out = out.slice(0, -Math.max(1, (bytes(out) - max) >> 1));
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

// Bound a file change set. Oversized text is replaced by an honest marker.
function boundFiles(files: FileEntry[]): FileEntry[] {
  let budget: number = ACTIVITY_LIMITS.diffBytes;
  return files.map((file) => {
    const size =
      bytes(file.patch || "") +
      bytes(file.before || "") +
      bytes(file.after || "");
    if (file.content !== "available" || size <= budget) {
      budget -= size;
      return file;
    }
    const { patch: _p, before: _b, after: _a, ...rest } = file;
    return {
      ...rest,
      content: "oversized" as const,
      reason: `Change is ${size} bytes; Loop retains up to ${ACTIVITY_LIMITS.diffBytes} bytes of diff text per activity.`,
    };
  });
}

function addOutput(
  data: OutputData,
  chunks: z.output<typeof OutputChunk>[],
): OutputData {
  const next: OutputData = {
    ...data,
    chunks: [...data.chunks],
    pending: [...data.pending],
    truncated: { ...data.truncated },
  };
  for (const chunk of chunks) {
    if (chunk.stream === "combined") next.streams = "combined";
    const index = chunk.index ?? next.nextIndex;
    // Duplicates and chunks already dropped by the retention bound are ignored.
    if (
      index < next.nextIndex ||
      index < next.truncated.floor ||
      next.pending.some((p) => p.index === index)
    )
      continue;
    next.pending.push({ stream: chunk.stream, text: chunk.text, index });
  }
  next.pending.sort((a, b) => a.index - b.index);
  const drain = () => {
    while (next.pending[0]?.index === next.nextIndex) {
      next.chunks.push(next.pending.shift()!);
      next.nextIndex++;
    }
  };
  drain();
  // A lost chunk must not stall output forever: skip the gap once bounded.
  while (next.pending.length > ACTIVITY_LIMITS.outputPending) {
    next.truncated.droppedChunks += next.pending[0].index - next.nextIndex;
    next.nextIndex = next.pending[0].index;
    drain();
  }
  let size = next.chunks.reduce((n, c) => n + bytes(c.text), 0);
  while (size > ACTIVITY_LIMITS.outputBytes && next.chunks.length) {
    const first = next.chunks[0];
    const excess = size - ACTIVITY_LIMITS.outputBytes;
    if (bytes(first.text) <= excess) {
      next.chunks.shift();
      size -= bytes(first.text);
      next.truncated.droppedBytes += bytes(first.text);
      next.truncated.droppedChunks++;
      next.truncated.floor = first.index + 1;
    } else {
      // Keep the newest tail of a partially retained chunk.
      const kept = [...first.text];
      let dropped = 0;
      while (dropped < excess && kept.length) dropped += bytes(kept.shift()!);
      next.chunks[0] = { ...first, text: kept.join("") };
      size -= dropped;
      next.truncated.droppedBytes += dropped;
    }
  }
  return next;
}

function mergeSetting(prev: Setting | undefined, patch: Setting): Setting {
  const out: Record<string, unknown> = { ...(prev || { id: patch.id }) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  // A confirmation or rejection settles the outstanding request.
  if (
    patch.requested === undefined &&
    (patch.confirmed !== undefined || patch.rejected)
  )
    delete out.requested;
  return out as Setting;
}

type ReduceResult =
  | { changed: true; record: ActivityRecord }
  | { changed: false; record: ActivityRecord | undefined; reason: string };

// Apply one update. Pure and deterministic: live, snapshot and replay paths
// share it, so the same ordered updates always reconstruct the same record.
//
// Rules:
// - The first update creates the record even if the producer's initial update
//   has not arrived; `partial` stays true until a live update supplies the
//   kind's defining fields (tool title/status, plan steps, files, ...).
// - Within a generation, a field is only replaced by an update with seq >= the
//   seq that last wrote it; a repeated seq with identical content is a no-op.
// - A different live generation adopts the record and resets field ordering.
//   Stale generations must be rejected at ingestion (see server/activities).
// - Replay updates never overwrite state written by a live update and never
//   advance tool/file/output lifecycle; they only fill absent fields.
// - Lifecycle never regresses (a completed tool cannot become running).
// - Settings/command catalogs ignore producer revisions older than current.
export function reduceActivity(
  previous: ActivityRecord | undefined,
  input: ActivityUpdate,
): ReduceResult {
  const update = ActivityUpdate.parse(input);
  if (previous && (previous.kind !== update.kind || previous.id !== update.id))
    throw new Error("Activity identity mismatch.");
  const record: ActivityRecord = previous
    ? (structuredClone(previous) as ActivityRecord)
    : ({
        v: ACTIVITY_VERSION,
        kind: update.kind,
        id: update.id,
        source: update.source,
        generation: update.generation,
        revision: 0,
        fieldSeq: {},
        partial: true,
        replayed: !!update.replay,
        data: empty(update.kind),
      } as ActivityRecord);
  if (
    previous &&
    update.generation &&
    update.generation !== previous.generation &&
    !update.replay
  ) {
    record.generation = update.generation;
    record.fieldSeq = {};
    // A restarted producer publishes a fresh session catalog, with revisions
    // starting over. Removed options must not survive the old generation.
    if (record.kind === "settings") record.data = { options: [], revision: 0 };
    if (record.kind === "commands") record.data = { commands: [], revision: 0 };
  }
  const seq = update.seq ?? Number.MAX_SAFE_INTEGER;
  const live = !update.replay;
  const sameGeneration =
    !previous || !update.generation || update.generation === record.generation;
  const accept = (field: string) => {
    const last = record.fieldSeq[field];
    if (!live && previous && !previous.replayed && last !== undefined)
      return false;
    if (
      last !== undefined &&
      sameGeneration &&
      update.seq !== undefined &&
      seq < last
    )
      return false;
    record.fieldSeq[field] = update.seq ?? last ?? 0;
    return true;
  };
  const set = <T extends object>(target: T, key: string, value: unknown) => {
    if (value === undefined || !accept(key)) return;
    if (value === null) delete (target as any)[key];
    else (target as any)[key] = value;
  };

  switch (record.kind) {
    case "plan": {
      const patch = update.patch as z.output<typeof PlanPatch>;
      const data = record.data;
      // Re-delivering an identical list (a retried loop_plan call, a replayed
      // native frame) is not a replacement and must not bump the revision.
      if (
        patch.steps &&
        accept("steps") &&
        JSON.stringify(patch.steps) !== JSON.stringify(data.steps)
      ) {
        data.steps = patch.steps;
        data.revision++;
      }
      set(data, "explanation", patch.explanation);
      if (patch.steps && live) record.partial = false;
      break;
    }
    case "tool": {
      const patch = update.patch as z.output<typeof ToolPatch>;
      const data = record.data;
      set(
        data,
        "title",
        patch.title && clip(patch.title, ACTIVITY_LIMITS.title),
      );
      set(data, "category", patch.category);
      set(data, "input", patch.input);
      set(data, "error", patch.error);
      set(data, "locations", patch.locations);
      if (patch.content && accept("content")) data.content = patch.content;
      if (patch.links) data.links = { ...data.links, ...patch.links };
      if (
        patch.status &&
        (live || record.replayed) &&
        TOOL_RANK[patch.status] >= TOOL_RANK[data.status] &&
        // A settled outcome is final; only an unknown one may be resolved.
        !(TOOL_RANK[data.status] === 3 && patch.status !== data.status) &&
        accept("status")
      )
        data.status = patch.status;
      if ((patch.title || patch.status) && live) record.partial = false;
      break;
    }
    case "file_change": {
      const patch = update.patch as z.output<typeof FileChangePatch>;
      const data = record.data;
      set(data, "tool", patch.tool);
      if (patch.files && accept("files")) data.files = boundFiles(patch.files);
      if (
        patch.state &&
        (live || record.replayed) &&
        FILE_RANK[patch.state] >= FILE_RANK[data.state] &&
        !(FILE_RANK[data.state] === 2 && patch.state !== data.state) &&
        accept("state")
      )
        data.state = patch.state;
      if (patch.files && live) record.partial = false;
      break;
    }
    case "output": {
      const patch = update.patch as z.output<typeof OutputPatch>;
      let data = record.data;
      set(data, "tool", patch.tool);
      set(data, "terminal", patch.terminal);
      set(data, "command", patch.command);
      set(data, "cwd", patch.cwd);
      set(data, "exitCode", patch.exitCode);
      set(data, "signal", patch.signal);
      set(data, "unavailable", patch.unavailable);
      if (patch.replace && accept("replace")) {
        data = record.data = addOutput(
          {
            ...(empty("output") as OutputData),
            ...pick(data),
            streams: "separate",
          },
          patch.replace.map((c, i) => ({ ...c, index: i })),
        );
      }
      if (patch.append && (live || record.replayed))
        record.data = data = addOutput(data, patch.append);
      if (patch.upstreamTruncated && !data.truncated.upstream)
        data.truncated = { ...data.truncated, upstream: true };
      if (
        patch.status &&
        (live || record.replayed) &&
        OUTPUT_RANK[patch.status] >= OUTPUT_RANK[data.status] &&
        !(OUTPUT_RANK[data.status] === 2 && patch.status !== data.status) &&
        accept("status")
      )
        data.status = patch.status;
      if (live) record.partial = false;
      break;
    }
    case "settings": {
      const patch = update.patch as z.output<typeof SettingsPatch>;
      const data = record.data;
      if (patch.revision !== undefined && patch.revision < data.revision)
        return { changed: false, record: previous, reason: "stale revision" };
      if (!live && previous && !previous.replayed)
        return { changed: false, record: previous, reason: "replay" };
      if (patch.revision !== undefined) data.revision = patch.revision;
      const byId = new Map(data.options.map((o) => [o.id, o]));
      for (const option of patch.options || [])
        byId.set(option.id, mergeSetting(byId.get(option.id), option));
      for (const id of patch.remove || []) byId.delete(id);
      data.options = [...byId.values()];
      if (live) record.partial = false;
      break;
    }
    case "commands": {
      const patch = update.patch as z.output<typeof CommandsPatch>;
      const data = record.data;
      if (patch.revision !== undefined && patch.revision < data.revision)
        return { changed: false, record: previous, reason: "stale revision" };
      if (!live && previous && !previous.replayed)
        return { changed: false, record: previous, reason: "replay" };
      data.commands = patch.commands;
      if (patch.revision !== undefined) data.revision = patch.revision;
      if (live) record.partial = false;
      break;
    }
  }
  if (live) record.replayed = false;
  const { revision: _a, fieldSeq: _b, ...after } = record;
  const before =
    previous && (({ revision, fieldSeq, ...rest }) => rest)(previous);
  if (previous && JSON.stringify(after) === JSON.stringify(before))
    return { changed: false, record: previous, reason: "no change" };
  record.revision = (previous?.revision || 0) + 1;
  if (bytes(JSON.stringify(record)) > ACTIVITY_LIMITS.record)
    return { changed: false, record: previous, reason: "record too large" };
  return { changed: true, record };
}

function pick(data: OutputData) {
  const {
    tool,
    terminal,
    command,
    cwd,
    exitCode,
    signal,
    unavailable,
    status,
  } = data;
  return {
    tool,
    terminal,
    command,
    cwd,
    exitCode,
    signal,
    unavailable,
    status,
  };
}

// Fold an ordered update log into records keyed by activityKey(update, turn).
export function reduceActivities(
  updates: { update: ActivityUpdate; turn?: string | null }[],
  initial = new Map<string, ActivityRecord>(),
) {
  const records = new Map(initial);
  for (const { update, turn } of updates) {
    const key = activityKey(update, turn);
    const result = reduceActivity(records.get(key), update);
    if (result.changed) records.set(key, result.record);
  }
  return records;
}

// Text of retained output, in order, for fallbacks and tests.
export function outputText(data: OutputData, stream?: "stdout" | "stderr") {
  return data.chunks
    .filter((c) => !stream || c.stream === stream)
    .map((c) => c.text)
    .join("");
}
