# Architecture

Loop has one React UI, workspace API and SQLite migration set. The companion workspace uses device pairing and a local host-owned worker. It runs directly on the host or in the Docker companion.

This page is the source map and core boundaries. Detailed topics have their own pages: [execution paths](execution.md), [workspace updates](workspace-updates.md) and [fleet architecture](fleet-architecture.md).

## Source map

| Boundary                                                  | Production source                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI and native harness discovery                          | [cli.ts](../src/cli.ts), [local-harnesses.ts](../src/server/local-harnesses.ts)                                                                                                                                                                                                                   |
| Companion host, worker ownership and device authorization | [workspace-host.ts](../src/workspace-host.ts), [host.ts](../src/host.ts), [device pairing](../src/server/device-pairing.ts)                                                                                                                                                                       |
| Agent-source discovery and paired proxy                   | [agent-sources.ts](../src/agent-sources.ts)                                                                                                                                                                                                                                                       |
| Workspace app and worker                                  | [index.ts](../src/server/index.ts), [worker.ts](../src/server/worker.ts)                                                                                                                                                                                                                          |
| Queue and managed model/tool loop                         | [queue.ts](../src/server/queue.ts), [agent-runtime.ts](../src/server/agent-runtime.ts)                                                                                                                                                                                                            |
| Native execution                                          | [native-sessions](../src/server/native-sessions.ts), [adapters](../src/adapters), [subscriptions](../src/server/subscriptions.ts)                                                                                                                                                                 |
| Companion execution authority                             | [execution-client.ts](../src/server/execution-client.ts), [execution-authority.ts](../src/server/execution-authority.ts), [process supervisor](../src/server/execution-process.ts), [ownership lock](../src/server/execution-ownership.ts), [wire contract](../src/shared/execution-authority.ts) |
| Database and migrations                                   | [db.ts](../src/server/db.ts), [migrations](../migrations)                                                                                                                                                                                                                                         |
| Persisted row contracts                                   | [SQL rows](../src/server/sql/rows.ts), [JSON row parsers](../src/server/row-schemas.ts), [per-table query modules](../src/server/sql/)                                                                                                                                                            |
| Feed and mobile-return API facade                         | [mobile-return.ts](../src/server/mobile-return.ts), [mobile-routes.ts](../src/server/mobile-routes.ts)                                                                                                                                                                                            |
| Reading position and outlines                             | [reading-position.ts](../src/server/mobile-return/reading-position.ts), [outlines.ts](../src/server/mobile-return/outlines.ts)                                                                                                                                                                    |
| Later and scheduled sends                                 | [later.ts](../src/server/mobile-return/later.ts), [scheduled-sends.ts](../src/server/mobile-return/scheduled-sends.ts)                                                                                                                                                                            |
| Queued-message editing and conversation forks             | [queued-runs.ts](../src/server/mobile-return/queued-runs.ts), [forking.ts](../src/server/mobile-return/forking.ts)                                                                                                                                                                                |
| Feed effect authorization                                 | [effect-authority.ts](../src/server/effect-authority.ts), [sourceAvailability.ts](../src/client/sourceAvailability.ts)                                                                                                                                                                            |
| Results stream (result cards and files, `/api/results`)   | [results.ts](../src/server/results.ts), [core-routes.ts](../src/server/core-routes.ts)                                                                                                                                                                                                            |
| Your profile, sent prompts and decision history           | [user-profile.ts](../src/server/user-profile.ts), [personal-history.ts](../src/server/personal-history.ts), [personal-decisions.ts](../src/server/personal-decisions.ts)                                                                                                                          |
| UI and shared contracts                                   | [client](../src/client), [shared](../src/shared), [workspace contracts](../src/shared/workspace-api.ts), [registrar](../src/server/registrar.ts), [browser API](../src/client/workspace-api.ts)                                                                                                   |
| Client state, navigation and session lifecycle            | [app/AppController.tsx](../src/client/app/AppController.tsx), [navigation state and URL targets](../src/client/app/Navigation.ts), [app/Session.tsx](../src/client/app/Session.tsx)                                                                                                               |
| Client shell and page composition                         | [App.tsx](../src/client/App.tsx), [app/AppView.tsx](../src/client/app/AppView.tsx), [app/AppPages.tsx](../src/client/app/AppPages.tsx), [explicit view props](../src/client/app/AppViewProps.ts)                                                                                                  |
| Client workspace loading and result paging                | [app/WorkspaceData.ts](../src/client/app/WorkspaceData.ts), [app/Results.tsx](../src/client/app/Results.tsx)                                                                                                                                                                                      |
| Composer UI, draft lifecycle and sends                    | [app/Composer.tsx](../src/client/app/Composer.tsx)                                                                                                                                                                                                                                                |

The feed reaches fleet authorization only through [effect-authority.ts](../src/server/effect-authority.ts), where fleet code registers its implementation, and the browser feed and composer reach fleet capability checks only through [sourceAvailability.ts](../src/client/sourceAvailability.ts); the [boundary test](../test/source-boundaries.test.ts) enforces this for the feed paths it names.

Browser code in `src/client` and server code in `src/server` never import each other; anything both need lives in `src/shared`, which imports neither. The [boundary test](../test/source-boundaries.test.ts) enforces this. Root modules and adapters may import shared contracts but never client code. Client and shared modules never import root modules. Native sign-in drivers depend on [their contract](../src/native-auth/types.ts), not the server coordinator or execution adapters; both Muse callers use the [MSP host](../src/muse-host.ts).

Device pairing and trust are core ([device-pairing.ts](../src/server/device-pairing.ts)) and need no machine identity; fleet enrollment extends them in [fleet-pairing.ts](../src/server/fleet-pairing.ts).

Fleet internals (machine identity, signed directories, peer credentials, remote workspace access and fleet mail) are in [fleet architecture](fleet-architecture.md).

## Saved rows

[Typed readers](../src/server/row-schemas.ts) validate persisted execution payloads and JSON metadata once, preserving owner predicates. Team setup, saved agent definitions, workspace content and continuation routes, artifact filing and PR-watch registration use the [owner-scoped readers](../src/server/domain.ts) before changing configuration or organization. The generic ownership guard returns `unknown`; execution uses one parsed `Run` and the [legal state map](../src/shared/run-state.ts). New records and update patches are strict; subscription status refresh preserves existing validated metadata while validating its new status fields. Saved execution payloads reject unknown fields. Metadata readers retain additional fields used by imported content while rejecting malformed identity, routing, permission and credential fields. Model catalog entries are strict; only an absent model display name defaults to its ID. Execution projects known fields into new output, leaving the saved historical payload intact. Invalid records fail closed with their row ID; malformed team configuration also remains unavailable for deletion and filtering. Artifact responses retain serialized metadata; continuation copies validate selected messages before creating a conversation and preserve historical extras inside their original metadata. Folder ancestry is validated when changing the parent; renames do not depend on unrelated ancestor display fields. Import cancellation checks ownership and scalar run identities without interpreting execution payloads or damaged import display fields; starting an import still validates its record.

Cancellation, dismissal, approval rejection, revocation and native interruption use owner-checked control fields without executing or repairing an invalid payload. Resuming or retrying saved work still requires its full validated row. A new turn validates only the prior folder and review identity it carries forward, then builds a fresh snapshot from the current agent and connection; invalid carried identities remain unavailable. Subscription logout validates owner, provider and routing separately from unused catalog, display and provider-secret fields. Explicit disconnect clears recovery markers in valid metadata even when routing is invalid, so startup cannot reconnect it. Teammate listings mark each damaged connection unavailable without blocking healthy peers. Background-result delivery reads owner-checked sender identities and outcome fields without executing its payload; uncertain sender locations are labelled unverified, while recipients still validate fresh execution data. Worker failures can end only the lease they still own; unleased malformed queue entries are rejected before dispatch. Public projections retain serialized JSON and never expose credential rows.

The shared [message metadata](../src/shared/message-metadata.ts), [run payload](../src/shared/run-payload.ts) and [artifact metadata](../src/shared/artifact-metadata.ts) modules own their columns' schemas and JSON codecs. The [JSON-column boundary check](../test/json-column-boundaries.test.ts), included in `npm run check`, validates literal SQL paths against those schemas and rejects direct codecs on column-named values outside their owners or named file exemptions. It resolves locally composed constant SQL and query aliases, including correlated subqueries; runtime/imported SQL builders, computed paths and arbitrary JavaScript renaming remain outside this syntactic check. The [closed-field check](../test/discriminating-fields.test.ts) covers these shared schemas, including message delivery.

## Published Results

A [Result](../src/shared/result.ts) is the immutable record of a published answer: run answers, explicit steering replies, imported answers and fork or continuation copies. [Publication](../src/server/result-publication.ts) seals its stimulus, outcome, attachments, provenance and lineage with a content digest; republishing identical facts is idempotent and a conflicting reuse of the identity is refused. Provenance records the producing agent, provider and model and, from schema version 2, the answer's `origin`: produced by a run, an external import, a copy that names the root original Result it came from, or unknown. A copy keeps its source's author rather than the receiving agent's; a missing or another owner's source is recorded as an unavailable copy with unknown authorship. Version 1 records keep their original digest serialization and record no origin.

[Result attachments](../src/server/result-attachments.ts) are uploads, whose objects are never rewritten, or published files, whose content-addressed objects are insert-only; message attachments cannot reference live text artifacts. A Result seals the object or published checksum it attached. Card preview and download both resolve those bytes under the owner's current artifact access; when they can no longer be identified, including a published reference without a checksum, the attachment is `unavailable` and only an explicit action opens the current artifact.

Done result cards and Replies enumerate sealed Results only; Saved shows a saved published answer's sealed Result. Result cards are projections rebuilt from those Results with mutable overlays (reads, dismissals, Trails, saves); raw transcripts decide neither which answers are published nor what they say. Eligibility is the rule Done always used: assistant output that is not a progress update and is not blank. Done is attributed to the sealed author, while folder filters and moves follow current organization: the folder the run recorded, otherwise the conversation's current folder. A card whose recorded publication project differs from its current one shows `produced_in`. Idle-thread, Working, Queued and approval cards remain operational state. Upgrades seal answers earlier builds listed without a Result, then rebuild result cards.

An imported answer's stimulus is the nearest question on its own export branch: parent pointers name provider node IDs, and one dropped node, such as a tool call, is bridged through its stored parent's children. Formats without parent pointers are linear and use the latest earlier question. A branch that cannot be followed (a missing node, a cycle or consecutive dropped nodes) has an unknown stimulus rather than another branch's question. Lineage `parentResultId` is the chronological predecessor, independent of stimulus and supplied context: the latest Result of any kind, sealed before this one, whose creation time is not later. Earlier history imported later therefore starts its own link, and sealed successors keep theirs.

[Result history](../src/server/result-history.ts) runs one-time passes inside the migration transaction. Upgrades from releases without Results seal standalone, imported and copied answers with the live publication policy, marking them `migrated_backfill` with an unknown publication placement. Databases whose Results were sealed by earlier builds are checked against retained evidence instead; disagreements — copies attributed to the receiving agent, imported answers sealed with another branch's question, and imported answers chained past an intervening Result — become append-only `result_defects` findings beside the untouched original record and digest. No pass invokes a provider, reruns work or replays an external effect.

## Workspace HTTP contracts

[Contract rules](contracts.md) owns contract authoring: the registrar, response projections, streams, multipart uploads, failures and the client helpers in [client/workspace-api.ts](../src/client/workspace-api.ts), which never retry writes. Integration bearer admission is in the [Integration API](cards-api.md). The [registry](../src/shared/workspace-api.ts) generates [OpenAPI](openapi.json) and its [event-channel companion](openapi-channels.json), checked by `npm run openapi:check`.

Rules not yet stated in a single file:

- Feed, conversation and Results handlers stay synchronous inside their snapshot transaction, so their bodies and watermarks describe the same committed state.
- The paired host authorizes devices, origins and CSRF before forwarding, and the session GET projects only the shell's user id and name and the `paired` mode.
- Automatic snapshot reads that exhaust their transient retries register recovery interest for their source and owner generation, and the shared watcher probes HTTP while it exists. Recovery cycles deliberately have no increasing backoff or retry cap, because a cap could leave a quiet failed view stale indefinitely; permanent refusals and writes never register recovery.

## Execution paths

How the companion reaches native harnesses, agent sources and the execution authority is in [execution paths](execution.md).

## Workspace updates

How changes reach browsers, sockets and pages is in [workspace updates](workspace-updates.md).

## Activities

Plans, tool lifecycle, diffs, command output, settings and command catalogs are activities: bounded, versioned display records keyed by producer identity.

| File | Owns |
| --- | --- |
| [agent-activities.ts](../src/shared/agent-activities.ts) | The activity record types; activities are display data, never applied as diffs or used as native context |
| [server/activities.ts](../src/server/activities.ts) | Persisting trusted owner, conversation and run scope; stale producers rejected; replay never advances live tool lifecycle |
| [activity-bridge.ts](../src/activity-bridge.ts) | Mapping native activity and historical records |
| [activityView.ts](../src/client/activityView.ts) and [activityHistory.ts](../src/client/activityHistory.ts) | Client snapshot pages, incremental updates and independent history and live cursors |
| [conversation-messages.ts](../src/server/conversation-messages.ts) | The transcript's indexed display projection |

Rules not yet stated in a single file:

- Native tool items and MCP calls persist durable activities when they arrive; activity reads never synthesize records from execution traces. Transcripts, reply quotes and reading positions do not read execution traces either.
- Conversation transcripts show human messages and public agent output, including progress updates. Tool calls, raw native events and activity records stay out of the transcript, except native failure and uncertain-delivery notices; they are available from **Tool activity** and the agent's Traces tab.
- Public assistant updates live in the message store with idempotent per-run producer keys. Message sequences stay stable through deletion and database compaction, and migration 073 kept the IDs and ordering cursors of older updates it copied.

## Memory, tools and files

MCP connections, broker checks and MCP Apps are described in [MCP tools](mcp.md).

| File | Owns |
| --- | --- |
| [memory.ts](../src/server/memory.ts) | Local keyword search; recall is untrusted historical evidence, never current authorization |
| [artifact-metadata.ts](../src/shared/artifact-metadata.ts) | One strict schema per artifact role |
| [imageUpload.ts](../src/client/imageUpload.ts) | Browser image scaling before upload |

Rules not yet stated in a single file:

- A streamed answer's search index and feed revisions keep their last snapshot until the run finishes; interrupted streams keep the last indexed snapshot until finalized. Scope, inclusion, revision and tombstone checks apply again before indexed candidates are returned.
- Message attachments reach native turns as file references read through `loop_read_file`; API-key connections also receive the current turn's images and PDFs inline.
- File publication validates the selected path, size and digest before storing private content; downloads require owner access, and a worker path alone is not a published file.

## Dependencies and boundaries

Workspace HTTP routes are defined in [workspace-api.ts](../src/shared/workspace-api.ts) and registered only through the [registrar](../src/server/registrar.ts); browser calls go through [client/workspace-api.ts](../src/client/workspace-api.ts) ([contract rules](contracts.md#client)). The paired host dispatches its device and source-management routes from the same registry, behind pairing and CSRF checks.

[deployment/versions.json](../deployment/versions.json) owns container provider pins. [host-control.ts](../src/host-control.ts) owns installed harness version checks. [package.json](../package.json) pins the ACP SDK. Validate each seam when updating it.

Dependencies retain their upstream licenses.

The application host is a single point of failure. Native tools are not a multi-tenant sandbox. Fixture tests establish protocol behavior, not provider availability, billing entitlement, device acceptance or deployment capacity. See [development](development.md) for verification boundaries.

Domain SQL moves into one module per primary table under `src/server/sql/`. Modules prepare statements lazily per supplied connection and parse returned rows with `parseRecord` and the canonical `QueryRecords` in [sql/rows.ts](../src/server/sql/rows.ts); partial and joined selections declare their columns beside the query. Callers retain ownership checks and transaction scopes, including `.immediate()`. The [SQL inventory](../test/sql-inventory.test.ts), run by `npm run check`, has a named file allowance that only shrinks: new files must use query modules, and a file leaves the allowance when its last direct call moves. The [column-parity check](../test/row-schema-columns.test.ts) compares every declared table record with a freshly migrated database. Migration runners, change publication and feed-projector infrastructure have explicit permanent exemptions; migrations remain point-in-time SQL.

### Recipe: add or extend a SQL table module

Canonical example: [sql/mcp-preferences.ts](../src/server/sql/mcp-preferences.ts), its caller [mcp/approval-policy.ts](../src/server/mcp/approval-policy.ts), and the route test that exercises it, [mcp-route-contracts.test.ts](../test/mcp-route-contracts.test.ts).

1. Search the generated [SQL index](sql-index.md) for the table and the function you need, and extend the module that owns the table. Only for a new primary table, start with `npm run new:sql-module -- <table>`, which writes the module in this shape and prints the remaining steps. Run `npm run sql-index` after changing a module.
2. Declare each query with `statement()` from [sql/statement.ts](../src/server/sql/statement.ts) and call it with the connection the caller supplies. Do not call `prepare` at module load or import `db` into the module.
3. Take the owner as a parameter and filter by `owner_id` in the SQL when the table has one. Do not open transactions in the module; callers keep `.immediate()` and their ownership checks.
4. Parse rows with `parseRecord` and `QueryRecords.<table>`, using `pick` or `extend` for partial and joined selections. For a new table, add its migration and `QueryRecords` entry; [row-schema-columns.test.ts](../test/row-schema-columns.test.ts) compares them.
5. Import the module as a namespace by its path from the caller (`import * as <table>Queries from "./sql/<table>.js"` in `src/server/`, `"../sql/<table>.js"` one level down) and test it through its production caller. The [SQL inventory](../test/sql-inventory.test.ts) must stay green.

If a step can't be followed, say which and why in the PR instead of working around it.
