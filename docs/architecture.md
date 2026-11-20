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

Saved rows are read through typed readers that validate each JSON column once, keep owner predicates and fail closed on invalid records. Each file below states its own rules in comments.

| File | Owns |
| --- | --- |
| [row-schemas.ts](../src/server/row-schemas.ts) | Typed readers, strict payloads, `InvalidRow` |
| [domain.ts](../src/server/domain.ts) | Owner-scoped readers, including the control-field readers that work on invalid payloads |
| [message-metadata.ts](../src/shared/message-metadata.ts), [run-payload.ts](../src/shared/run-payload.ts), [artifact-metadata.ts](../src/shared/artifact-metadata.ts) | Each column's schema and JSON codec |
| [json-column-boundaries.test.ts](../test/json-column-boundaries.test.ts), [discriminating-fields.test.ts](../test/discriminating-fields.test.ts) | Checks that SQL JSON paths and codecs stay with those owners; the first is syntactic, so runtime SQL builders and computed paths are outside it |

Rules not yet stated in a single file:

- Explicit disconnect clears recovery markers in valid metadata even when routing is invalid, so startup cannot reconnect it.
- Teammate listings mark each damaged connection unavailable without blocking healthy peers.
- Background-result delivery reads owner-checked sender identities and outcome fields without executing its payload; uncertain sender locations are labelled unverified, while recipients still validate fresh execution data.

## Published Results

A [Result](../src/shared/result.ts) is the immutable record of a published answer: run answers, explicit steering replies, imported answers and fork or continuation copies.

| File | Owns |
| --- | --- |
| [result-publication.ts](../src/server/result-publication.ts) | Sealing, idempotence, provenance and origin, eligibility, imported stimulus, lineage |
| [result-attachments.ts](../src/server/result-attachments.ts) | Immutable attachment bytes and `unavailable` attachments |
| [result-history.ts](../src/server/result-history.ts) | One-time upgrade passes: backfill and append-only `result_defects` |

Rules that span those files and the Feed:

- Done result cards and Replies enumerate sealed Results only, and the `/saved` list shows a saved answer's sealed Result. The browser's Saved page reads [cards.ts](../src/server/cards.ts) instead, which lists bookmarked artifacts and messages, not Results. Result cards are projections rebuilt from Results with mutable overlays (reads, dismissals, Trails, saves); raw transcripts decide neither which answers are published nor what they say.
- Done is attributed to the sealed author, while folder filters and moves follow current organization: the folder the run recorded, otherwise the conversation's current folder. A card whose publication project differs from its current one shows `produced_in`. Idle-thread, Working, Queued and approval cards remain operational state.
- New run results record recalled sealed evidence in `lineage.suppliedContext` and the result context edges. Each entry records the exact supplied excerpt and the sealed source digest. Lineage keeps the first eligible excerpt per result within the existing context limits. Edited sources stay visible in recall and receipts, while their text is excluded from sealed lineage. Historical republishing leaves this lineage empty when no recall receipt was recorded.

## Workspace HTTP contracts

[Contract rules](contracts.md) owns contract authoring: the registrar, response projections, streams, multipart uploads, failures and the client helpers in [client/workspace-api.ts](../src/client/workspace-api.ts), which never retry writes. Integration bearer admission is in the [Integration API](cards-api.md). The [registry](../src/shared/workspace-api.ts) generates [OpenAPI](openapi.json) and its [event-channel companion](openapi-channels.json), checked by `npm run openapi:check`.

Rules not yet stated in a single file:

- Feed, conversation and Results handlers stay synchronous inside their snapshot transaction, so their bodies and watermarks describe the same committed state.
- The paired host authorizes devices, origins and CSRF before forwarding, and the session GET projects only the shell's user id and name and the `paired` mode.
- Automatic snapshot reads that exhaust their transient retries or fail on a network error register recovery interest for their source and owner generation, and the shared watcher probes HTTP while it exists. Recovery cycles deliberately have no increasing backoff or retry cap, because a cap could leave a quiet failed view stale indefinitely; permanent refusals and writes never register recovery.

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
| [memory.ts](../src/server/memory.ts) | Local keyword search and first-turn recall: up to five sources (6,000 characters) that share enough of the turn's terms, appended to the input as untrusted historical evidence, never current authorization, with a run receipt |
| [artifact-metadata.ts](../src/shared/artifact-metadata.ts) | One strict schema per artifact role |
| [imageUpload.ts](../src/client/imageUpload.ts) | Browser image scaling before upload |

Rules not yet stated in a single file:

- A streamed answer's search index and feed revisions keep their last snapshot until the run finishes; interrupted streams keep the last indexed snapshot until finalized. Scope, inclusion, revision and tombstone checks apply again before indexed candidates are returned.
- A conversation's first native or API-key turn gets recall from its owner's eligible memory (workspace and project policy apply): published results, pinned artifacts, notes and included conversations, excluding the turn's own conversation. Later turns and snapshot reviews get none. Native turns hash the input including recall before dispatch; API-key turns keep it in the checkpoint, so a resumed run does not search again.
- Recall indexes raw passage offsets at each memory source revision, with headings and paragraphs packed together and short fenced code blocks kept intact. Overlapping note and artifact passages preserve evidence that straddles a block boundary. Passage row IDs stay stable during SQLite compaction. BM25 ranks passages by title and body using the first eight search terms for automatic recall and up to 24 for ordinary searches. The relevance check uses up to 24 terms, though terms beyond the first eight cannot nominate a passage. The top 75 passage candidates are considered before deduplication, so a large source can crowd out others. Published results must supply body evidence for longer queries. Candidates collapse to one hit per source. A nominated passage must meet relevance before recall compares other passages from the same source. Recall trims the strongest qualifying raw body evidence to 1,100 characters, including elision marks, and checks the title and excerpt together for relevance. During backfill, sources missing a current passage revision still use document search with its 12,000-character scan limit. Search applies owner, project, revision and conversation eligibility to both paths.
- Source writes update their passages in the same transaction. A tombstone removes the derived passage and its FTS entry. Background capture indexes at most 100 existing source revisions per pass. Policy-only revisions update the offsets’ revision in the same transaction. The original sources and their history remain available throughout the backfill.
- First-turn recall extracts date windows from a fixed set of explicit forms. It uses the submitted turn’s UTC date, and weeks begin on Monday. It recognizes ISO dates or named months introduced by a date preposition, today, yesterday, tomorrow, relative day and week offsets, and the current or previous calendar week or month. A named month may include a four-digit year. Bare ISO dates and bare month-and-year text remain searchable. It also accepts ISO ranges written as “from DATE to DATE” and explicit cutoffs using “since,” “before,” “after,” “on or before,” “on or after,” “no earlier than,” or “no later than.” After starts at the end of the referenced period. When one period fits inside another, recall uses the narrower period.
- Quoted text, fenced code and code identifiers stay searchable. The parser leaves recognized exclusions, alternatives and incompatible periods in the search text, without applying a date window. The grammar is limited to the explicit forms above. Wording outside it receives ordinary lexical recall when no supported window is found.
- A window filters on source update time with an inclusive lower bound and exclusive upper bound. Artifacts use their stored update time, which includes metadata edits. Captured messages use their original creation time, including older saved records indexed later. Note policy revisions preserve note update times.
- Agents can search saved memory through the [native memory search tool](mcp.md#search-saved-loop-memory). Search receipts append to the same run record as automatic recall. Historical receipt entries without a source label still display.
- Dated recall nominates passages with the first six terms after removing the recognized date phrase. Relevance checks the full term set. Date-only prompts abstain because nomination requires a lexical match. The date window applies to the ranked candidate pool, so out-of-window matches can occupy nomination slots. When no candidate qualifies, dated recall abstains.
- Each excerpt is headed `[id@revision] <result|note|message> by <you|agent name|unknown author>, <updated date, UTC>, "<title>", <link>`. The run's receipt records its kind, author and update timestamp. A user-role message gets the author label “you” only if the message records that the owner typed it without shared content.
- Automatic recall uses matching per-run random nonces on the evidence delimiters. Every excerpt line starts with `│ ` and the preamble identifies these lines as untrusted quoted data. Tag lookalikes and an occurrence of the active nonce are escaped in quoted fields.
- Recorded web search or fetch, `loop_feed`, and third-party MCP calls mark a producing run’s recalled answer `external-content`. Automatic recall skips these answers and agent search returns them with the label. Classification uses native calls, brokered invocations and identified native tool traces. Historical answers with insufficient tool records remain eligible without the label.
- Recalled sealed results include the result ID, a digest prefix and a checkout citation when the end capture has settled with a recorded commit and was not recovered late. Edited source artifacts are labelled. The receipt marks a source cited by literal bracketed ID and revision, or by a literal link that identifies a single source revision. For API-key turns, a tool hit counts as supplied once the provider responds to a request containing the hit. The receipt marks an unconfirmed API hit as undelivered. Native search records the tool result before the bridge sends it. Without an acknowledgement from the harness, a lost response can leave a receipt and sealed lineage for evidence it did not receive. A native retry rechecks checkout metadata and retains the original call receipt.
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
