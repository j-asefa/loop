# Shared agent activities

Plans, tool calls, file changes, command output, session settings and command
catalogs use one versioned model for every way Loop runs an agent: direct
native harnesses, the API-provider runtime and ACP. The model is display data.
Harnesses keep their own context; Loop never feeds activities back to a model,
never applies a reported diff, and never treats a requested setting as effective.

| Piece | File |
| --- | --- |
| Contract, validation, reducer | `src/agent-activities.ts` |
| Persistence, ingestion, projection API | `src/server/activities.ts`, `migrations/030-agent-activities.sql` |
| API-provider producer | `src/server/agent-runtime.ts`, `loop_plan` in `src/server/native-tools.ts` |
| Native/ACP ingestion | `ingestNativeActivity` in `src/server/activities.ts` (called from `NativeSessions.event`, see "Adapter event interface") |
| Direct extraction → shared update | `directUpdates` in `src/adapters/direct-activities.ts`, one mapping (`directActivityUpdate` in `src/activity-bridge.ts`) shared by live adapters, native history and subscription runtimes |
| Subscription runtime producer | `codexActivity`/`claudeActivities` in `runtime/traces.mjs`, `src/server/runtime-activities.ts` |
| Native history replay | `historyActivities` / `historyProjection` in `src/server/native-history.ts` |
| Client snapshot + incremental sync, panel props | `src/client/activityView.ts` |

## Records

A producer sends partial `ActivityUpdate`s:

```ts
{
  v: 1,
  kind: "plan" | "tool" | "file_change" | "output" | "settings" | "commands",
  id: string,              // stable producer identity, never a display title
  source: { transport: "native" | "api" | "acp", harness?: string, origin: string },
  generation?: string,     // producer process generation
  seq?: number,            // monotonic per (generation, activity)
  replay?: boolean,        // native history hydration
  patch: { ... }           // kind-specific, see src/agent-activities.ts
}
```

In every patch an absent field keeps its value, `null` clears it, and any other
value replaces it.

| Kind | Scope | Notes |
| --- | --- | --- |
| `plan` | turn | `steps` replaces the whole list and increments `revision`. Step ids come from the producer; if it has none, `step-<index>` is marked `positional`. |
| `tool` | turn | Lifecycle `proposed → waiting/running → unknown → completed/failed/cancelled`. It never goes backwards, and a settled outcome is final; only `unknown` can be resolved later. `links.broker`/`links.trace`/`links.native` carry invocation identities for de-duplication. |
| `file_change` | turn | Supports `create`/`modify`/`delete`/`rename`. `content` is `available`, `binary`, `oversized` or `unavailable`. `state` is one of `proposed`, `applied`, `failed` or `unknown`. |
| `output` | turn | Ordered `stdout`/`stderr` chunks (or honest `combined`), with an optional producer `index`. `replace` supplies the final output when a source cannot stream. Also records exit code, signal and status. `unavailable` explains output Loop could not host. |
| `settings` | conversation | Options upsert by id. `confirmed` is only written from the authoritative runtime. `requested` is a pending ask, and `rejected` explains a refusal; either a confirmation or a rejection clears `requested`. Options also carry `application` (`live`/`next-turn`/`new-session`), `mutable`, `reason`, `provenance` and a producer `revision`. |
| `commands` | conversation | The complete catalog each time, so removals are explicit. Carries a producer `revision`. |

Capabilities are stored per conversation and transport. Each is
`{ state: "supported" | "unsupported" | "undiscovered", source, reason? }` for
`plans`, `tools`, `diffs`, `output`, `settings` and `commands`.

## Reducer rules

`reduceActivity(previous, update)` is pure. Live events, persistence, snapshot
refresh and replay all use it, so they reconstruct the same record.

- The first update creates the record, even when it arrives before the
  producer's initial update. The record stays `partial` until a live update
  supplies the kind's defining fields.
- Within a generation, a field is only overwritten by an update whose `seq` is
  at least the `seq` that last wrote it. Out-of-order updates still fill fields
  they own. An unsequenced update applies in arrival order.
- Identical re-delivery is a no-op and does not bump `revision`.
- A different live generation adopts the record and resets field ordering. The
  server rejects stale generations before reducing (see below).
- Replay (`replay: true`) only fills fields that no live update has written. It
  never advances tool, file or output lifecycle on a live record, so reloading
  native history never marks work as newly executed.
- Settings and command catalogs ignore producer revisions older than the current one.
- Bounds (`ACTIVITY_LIMITS`): output keeps the newest 64 KiB. Earlier output is
  counted in `truncated` (`droppedBytes`, `droppedChunks`, `floor`), and late
  duplicates of dropped chunks are ignored. After 64 chunks wait on a gap, the
  gap is skipped and counted. A diff over 256 KiB per record becomes
  `oversized` with a reason. Records over 512 KiB are rejected.

## Persistence and projection

`applyActivity(scope, update)` validates the update and folds it into
`agent_activities` inside one immediate transaction. The scope is
`{ owner, conversation, run, generation }` and always comes from trusted server
state; an update cannot choose its owner, conversation or turn. The write
assigns a per-owner `sequence` and emits `activity.updated` for the run. The
API returns reasons instead of throwing, because display data must never fail
or interrupt a run.

- Turn kinds are keyed `kind:transport:origin:<run>:<id>`, and session kinds
  `kind:transport:origin:session:<id>`. Replayed history loaded outside a turn
  uses `history` as its turn, so stable native ids de-duplicate across reloads.
- If `scope.generation` is set and a non-replay update carries another
  generation, it is quarantined as `stale generation`.
- `ingestNativeActivity(live, update)` derives the scope from the live session:
  the conversation from its binding, the current run and the live process
  generation. Between turns there is no run, so only session kinds and
  `replay` updates (keyed under `history`) are accepted there. Updates over
  1 MiB (`ACTIVITY_LIMITS.ingest`), invalid updates, updates for an unknown
  conversation and stale-generation updates are dropped with a reason and
  never interrupt the native turn.

`GET /api/conversations/:id/activities[?after=<sequence>&run=<id>]` is
owner-authorized and returns `{ version, items, cursor, more }`. Each item is
`{ key, kind, run, sequence, record }`. A full load also projects older
`run_traces` tool rows as read-only `legacy` tool records, unless an activity
already links that trace with `links.trace`. Old histories therefore render
with the same components, and no data is migrated or rewritten. `loop_plan`
traces are left out because the plan activity represents them.

## Wire compatibility

- Records are only served by the additive REST projection. Change notification
  is an ordinary `activity.updated` row in `events` whose payload is
  `{ key, kind, sequence }` (never content). The web poll and the v2 workspace
  socket already treat any event as "refresh", so a cached PWA that predates
  activities keeps working and simply never requests the endpoint. No new frame
  variant, `ServerFrame` or `Snapshot` field is sent to any client.
- `src/client/activityView.ts` loads the full snapshot, then `?after=<cursor>`
  on each `loop-workspace-change` (and a 5 s fallback poll), replacing items by
  key and never letting an older `sequence` win. Records are already reduced on
  the server, so refresh, reconnect and completed history render identical
  records. A desktop without the endpoint yields no activities. Unknown record
  versions are skipped. `activityViews` maps records to the props of the shared
  `PlanPanel`, `FileChangePanel` and `CommandOutputPanel` components; explicit
  `null` before/after (create/delete) stays distinct from omitted content.
- A full load includes `legacy` trace projections only when the conversation
  fits in one page (500 records); incremental pages never include them.

## Adapter event interface

Adapters report activities with `ActivityEvent` from `src/agent-activities.ts`,
which is a member of `AdapterEvent` in `src/protocol.ts`:

```ts
type ActivityEvent = { type: "activity"; activity: ActivityUpdate };
// and { type: "activity_capabilities"; capabilities: ActivityCapabilities }
```

The adapter supplies only the protocol identity (`id`, `source`, optional
`seq` and `replay`). Direct adapters convert their `DirectActivity`
extractions with `directUpdates(harness, values)` wrapped by
`directActivityEmitter`, which adds instance-local `seq`; ACP maps
`session/update` notifications in `src/adapters/acp.ts`.

Ingress is `NativeSessions.event` → `NativeSessions.activity`
(`src/server/native-sessions.ts`), before the 256000-byte item guard so that
display data never interrupts native work:

1. Events from a `Live` that is closed or no longer the registered session for
   its conversation are dropped (generation isolation).
2. The update is dropped unless `companion_sessions.generation` still equals
   the live generation.
3. Run-scoped kinds (plan, tool, file_change, output) are accepted only while a
   run is active; settings/commands may arrive between turns.
4. The server stamps `generation` and calls `ingestNativeActivity`, which
   derives owner, conversation and run from the live session, never from the
   update.

`src/host.ts` drops both variants, so the strict v1 host wire never carries
them.

## Native history

`historyActivities(thread)` runs the Codex direct extractor over saved
`commandExecution` and `fileChange` items and marks every update
`replay: true`. `GET /api/native/history/:id` adds an `activities` array folded
with the shared reducer (read-only, not persisted), and forking persists the
same updates into the new conversation under `history` keys. Repeating a fork
or a reload de-duplicates by key, and replayed records never advance
lifecycle on live records. Codex thread items carry no plan, so none is shown
for history.

## API-provider runtime

- **Plans:** `loop_plan` is registered with Loop's native tools and advertised
  only by `executeAgent`, not on the native MCP bridge, where harnesses publish
  their own plans. Its schema is validated with zod, and duplicate step ids are
  rejected. It is idempotent per call id through `native_calls` and needs no
  approval. Its tool description says how to call it (complete list, stable
  ids, one step `in_progress`). The run instructions say when:
  `runtimeInstructions` appends `PLAN_GUIDANCE` after the agent's own
  instructions whenever `loop_plan` is advertised (not for workflow runs). The
  stored agent instructions and run snapshot are unchanged. Re-sending an
  identical list is a no-op and does not bump the plan revision. Plans are
  never parsed from prose or reasoning. The schema is
  a plain top-level object without `$ref`, which OpenAI (`strict: false`) and
  Anthropic `input_schema` accept, and the broker's Ajv 2020 dialect compiles.
- **Tools:** `executeAgent` records the tool lifecycle from the real broker
  outcome. It moves through `running`, `waiting` (approval or child runs), and
  then `completed` or `failed`. A failure uses the tool error text. `unknown` is
  used when the broker marked the invocation outcome uncertain. The record
  links the broker call id and the `tool:<callId>` trace, and its content
  references the saved result artifact plus bounded text. `loop_plan` calls do
  not produce a tool card.
- **Settings:** The model and effort are confirmed from the run snapshot Loop
  enforces. They are `next-turn`, `mutable: false`, and edited in agent settings.
- **Subscription runtimes:** Codex and Claude Code subscription connections
  run through `executeAgent`, but the work executes in the runtime's own
  harness. `runtime/traces.mjs` serializes that executor's structured results
  as bounded `chunk.activity` payloads next to the existing text traces:
  Codex `commandExecution`, `fileChange` and `turn/plan/updated`
  (`codexActivity`), and correlated Claude Code `Bash`/`Write`/`Edit` results
  plus `TodoWrite` plans (`claudeActivities`; other tools are not forwarded).
  Both `runtime/entry.mjs` and the remote app-server client
  (`src/server/codex-app-server.ts`) emit them. `src/server/runtime-activities.ts`
  maps them with the same extractors and `directUpdates` mapping as the direct
  native adapters, as `source: { transport: "api", harness, origin:
  "<harness>:runtime" }`, scoped to the run by the server. Provider-key
  adapters cannot inject them: `executeAgent` ignores `chunk.activity` unless
  the connection is a subscription.
- **Capabilities:** Provider-key runs report diffs, command output and
  commands `unsupported`: they execute only Loop's tool broker, whose MCP
  results carry no trusted file-change or command metadata (arbitrary MCP
  results are never interpreted as diffs), and the command picker has no
  catalog for them. Subscription runs report commands `supported` (the
  runtime catalog behind `GET /agents/:id/harness`), and diffs/output
  `undiscovered` until the runtime returns its first structured result, then
  `supported`. Runtimes older than this build send only text traces.

## Producer checklist (native adapters, ACP)

1. Emit `{ type: "activity", activity }` through the adapter's `Emit`. Use the
   protocol's own identifiers as `id` (e.g. ACP `toolCallId`, Codex item id),
   leave `generation` to the server (NativeSessions stamps the live process
   generation), and send `seq` when the
   source orders events.
2. For tools that are really Loop workspace tools called through the MCP
   bridge, set `links.broker` to the bridge call id. For tools that also
   produce a `run_traces` row, set `links.trace` to that trace key. The UI and
   legacy projection use these links to avoid duplicate cards.
3. Send `replay: true` for anything reconstructed from `session/load` or native
   history.
4. Put diffs in `file_change` records and output in `output` records, and
   reference them from the tool's `content` (`{ type: "file_change" | "output", activity }`).
   Unhosted ACP terminals are `{ type: "unavailable", label, reason }`.
5. Write `settings.confirmed` only from the runtime's confirmation. Record user
   asks as `requested` and refusals as `rejected`.
6. Call `setActivityCapabilities` with the provenance of each answer. Leave a
   feature `undiscovered` until the runtime has actually been asked.

## Validation (2026-09-27)

Deterministic tests only; no paid provider or live harness calls.

- `npx vitest run tests/agent-activities.test.ts tests/activities-server.test.ts tests/activities-native.test.ts tests/activities-integration.test.ts tests/direct-activities.test.ts tests/activity-panels.test.tsx --maxWorkers 1`
  covers partial/null semantics, duplicate and out-of-order delivery,
  generation isolation, output/diff bounds, persisted records equal to the pure
  fold, history replay identity and fork idempotence, the client merge/view
  projection including hostile paths, legacy trace projection, owner
  isolation, the API-provider plan/tool/settings path through a test provider
  adapter, `loop_plan` schema compatibility, and migration 030 preserving
  `companion_sessions` bindings.
- `npm run typecheck`: passed.
- `npm test` (full vitest): 302/341 passed on this branch before the final
  focused fixes; every remaining failure is in `tests/runtime-contract.test.ts`
  (30) and `tests/native-host.test.ts` (3), which fail identically on the
  unmodified base `4b63310` in this environment. (`tests/access.test.ts` failed
  once only while a second suite ran concurrently; it passes 10/10 alone.)
- `npm run test:native`: 73/75 passed. Both failures (`native launcher
  provisions a real mTLS worker…`, `crash recovery stops only containers…`)
  are `spawn docker EACCES`: Docker is unavailable here, and they also fail on
  the base.
- `loop_plan` is only invocable by callers that pass `{ plans: true }` to
  `invokeNative` (the API runtime). The native MCP bridge and HAPI gateway
  neither list nor accept it; a test asserts the 403.
- Not yet validated: native adapters emitting live through `NativeSessions`
  (pending the wiring above), browser rendering of persisted records inside the
  conversation view (client UI owner), and ACP producers.
