# Working on Loop

Start with [README.md](README.md) for build and run commands. Load only the guide relevant to the task; [docs/README.md](docs/README.md) is the full index.

| Task                                                 | Read next                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Host operation or deployment                         | [Server operation](docs/server.md)                                              |
| CLI, harness discovery or native launcher       | [Harnesses](docs/harnesses.md)                                                  |
| Device authentication, tunnels or reconnect          | [Pairing](docs/pairing.md)                                                      |
| Runtime routing, persistence, activities or memory   | [Architecture](docs/architecture.md)                                            |
| A state, transition or writer of a stateful record   | [State machines](docs/state-machines.md)                                        |
| MCP, teams or workspace features                     | [Workspace](docs/workspace.md)                                                  |
| Tests, builds or CI                                  | [Development](docs/development.md)                                              |

Keep one canonical explanation per topic and link to it. Verify commands against package scripts and CLI parsing, behavior against production entrypoints, and pins against their source files. Historical plans and validation reports live in Git history; record new execution evidence in the PR rather than presenting it as permanent product behavior.

Preserve owner/profile isolation, durable dispatch identities and generation-bound decisions. Never replay an uncertain external effect automatically. Keep native context owned by its harness and credentials out of browser-visible content. Add regressions at the production boundary being changed; use [development](docs/development.md) to choose checks. Run `npm run check` before every PR and record its output there. Distinguish fixture coverage from live provider/device validation.

Loop v0.1.0 has an installed user base. Upgrades must preserve historical data and conversations, including saved answers, published files and their references, and related durable identities. Validate migrations and stored-record readers against records that released versions could create; a fresh database alone does not establish upgrade safety. Keep compatibility at storage boundaries where it is needed to retain readable history. Never reconstruct missing history by automatically replaying uncertain external effects.

API-only breaking changes are permitted. Preserving earlier wire shapes or mixed-version fleet operation is not a requirement by itself. Current pending command identities must still survive reloads and uncertain responses. Changes to saved launch state must keep existing workspaces accessible.

Loop ships only the companion workspace (`loop start`), including its Docker companion. There is no hosted server profile or separate server sign-in.

## Patterns to follow

Reuse the mechanism that already owns the behavior. Read only the matching example below and its callers; expand another section only when your change crosses that boundary. Examples illustrate the named pattern, not every detail in the file. The [architecture guide](docs/architecture.md) remains the canonical boundary reference; keep these links current when moving code.

- Shared facts or state vocabulary → **One definition, distinct policies**.
- Stored rows or SQL → **Query modules and derived row schemas**.
- External clients or test dependencies → **Dependencies scoped to the work**.
- Browser data or owner changes → **One owner and read lifetime**.
- Commands or lost responses → **Durable command identities**.
- Routes, IDs or notifications → **Explicit typed contracts**.

<details>
<summary>One definition, distinct policies — shared facts and state vocabulary</summary>

Read [harness descriptors](src/shared/harnesses.ts) with [local discovery](src/server/local-harnesses.ts), or [run states](src/shared/run-state.ts). Define shared facts once and derive consumers, including SQL state lists, from that owner. Keep protocol implementations and host discovery in their own layers. Preserve meaningful distinctions: started, active and terminal are different policies; `waiting_children` is a display state, not a stored transition. Follow [descriptor tests](test/harness-descriptors.test.ts) when changing a harness fact across consumers.

</details>

<details>
<summary>Query modules and derived row schemas — stored rows and SQL</summary>

Read [Later queries](src/server/sql/later-items.ts) with their caller in [Later operations](src/server/mobile-return/later.ts). SQL and row parsing belong in the query module; feature code owns orchestration. [Statements](src/server/sql/statement.ts) prepare lazily against the supplied connection. Preserve the requesting owner's predicates in owner-scoped operations; worker scans have different scopes.

For row shapes, follow `RunRecord` in [SQL rows](src/server/sql/rows.ts) and `RunRow`, `RunControl` and `RunNotice` in [row schemas](src/server/row-schemas.ts): derive decoded and partial views from the canonical schema rather than copying columns or adding aliases that merely rename it. Control paths need not decode execution payloads. Preserve released stored values under the upgrade policy above. Lazy statements do not imply that every database module is safe to import without initialization effects.

</details>

<details>
<summary>Dependencies scoped to the work — external clients and fixtures</summary>

Read `createGithubClient` and `withGithubClient` in [GitHub transport](src/server/github-api.ts), with [isolation tests](test/github-api.test.ts). Client instances capture immutable transport dependencies; an async scope supplies the instance to the work that needs it. Follow this when replacing a mutable process-wide fixture setter: overlapping operations must not change each other's destination or credentials. Transport injection does not replace owner authorization or token selection, and must not expose fixture destinations as browser inputs or product settings.

</details>

<details>
<summary>One owner and read lifetime — browser data and owner changes</summary>

Read [OwnerSessionBoundary](src/client/app/OwnerSessionBoundary.tsx) with [ownerSession](src/client/ownerSession.ts): owner generation owns the controller lifetime; same-owner metadata updates retain it. Capture one-shot entry navigation outside that remount and never transfer it to a replacement owner. Register module-lifetime caches centrally; dispose view readers with their view.

For a snapshot, follow `PersonalApprovalSheet` in [PersonalDecisions](src/client/PersonalDecisions.tsx), using `useProjectionQuery` and `CollectionReadNotice` from [CollectionRead](src/client/CollectionRead.tsx). For imperative GETs use `useProjectionRoute` in [SourceContext](src/client/SourceContext.tsx). The [read executor](src/client/read-executor.ts) owns cancellation, stale-result fencing and trailing refreshes; features retain selection, pagination and refresh policy. Choose the existing read mode deliberately; do not add a second retry loop or send GETs through command transport. Keep read notices separate from action failures. See [owner-session](test/owner-session.test.ts) and [executor regressions](test/read-executor.test.ts).

</details>

<details>
<summary>Durable command identities — commands and lost responses</summary>

Read `performStoredEffect` in [pendingCommands](src/client/pendingCommands.ts) with its [native settings caller](src/client/SessionActivityControls.tsx). Persist identity before dispatch, scoped to owner, source and the operation's actual target/context. Preparation failure prevents dispatch; owner/view changes fence both dispatch and publication. Uncertain outcomes retain identity across reloads. Settlement must not clear a newer attempt.

For richer recovery UI, read [DoneThreads](src/client/DoneThreads.tsx): recovering the original request and explicitly starting a separate action are different user intents. Superseding archives uncertainty before releasing its slot; it neither dispatches a replacement nor settles the server receipt. Do not infer a generic replay policy from GET recovery. See [effect identities](test/effect-identities.test.ts) and the production-component journey in [Done-thread identity checks](scripts/done-thread-identity-browser-smoke.mjs).

</details>

<details>
<summary>Explicit typed contracts — routes, identities and notifications</summary>

Follow the explicit `operation` in [route contracts](src/shared/route-contract.ts), consumed by the [registrar](src/server/registrar.ts). A durable operation identity must survive registry-key or file renames; [operation tests](test/workspace-operation-contracts.test.ts) pin it. Reuse [canonical IDs](src/shared/contract-ids.ts) at contract boundaries, retaining the boundary's validation; raw internal builder inputs do not justify response-ID casts or branding every server parameter.

For browser notifications, follow [clientEvents](src/client/clientEvents.ts) and its [toast caller](src/client/toast.tsx): declare the payload once, use typed emit/listen helpers, and unsubscribe on cleanup. Keep feature behavior outside the transport. Shared event-to-collection policy belongs beside [workspace events](src/shared/workspace-events.ts), as `reconciliationScopes` and `DEADLINE_WORKSPACE_COLLECTIONS` demonstrate; callers retain their queue and timer lifetimes.

</details>

For regressions, test observable behavior through the affected production caller: owner replacement, cancellation, concurrent dependency scopes, or lost command responses. A helper test alone does not establish its caller's recovery behavior. Use the [development guide](docs/development.md#manual-verification) for checks and distinguish fixtures from live validation.

## Evidence for review

Reviewers should identify the relevant evidence in the diff and PR:

| Rule | Evidence to look for |
| ---- | -------------------- |
| Owner/profile isolation | New reads and writes use the requesting owner and intended profile; boundary tests cover another owner's access and the affected profiles. |
| Dispatch identity and generation | A new external effect has a durable identity recorded before dispatch; decisions are checked against the current session generation. |
| Uncertain effects | Timeouts and disconnects preserve an uncertain outcome and do not automatically submit the effect again; a regression exercises the production retry/recovery caller. |
| Native context and credentials | Browser responses and events expose explicit safe fields; harness-owned session context and credentials stay on their owning side of that boundary. |
| Source and API boundaries | Imports obey the [source layers](docs/architecture.md); new routes use the typed registrar and named legacy inventories only shrink. |
| SQL query modules | Domain SQL lives in [per-table modules](src/server/sql/); preparation is lazy, rows use existing schemas, and the [SQL inventory](test/sql-inventory.test.ts) file allowance only shrinks; migrated files have no direct SQL calls. Migration and projection infrastructure exemptions stay explicit. |
| Formatting | All source, test and script files use the pinned formatter; no repository ignore exceptions are added. |
| Historical data preservation | Released data remains stored and readable after upgrades. Migration fixtures retain content, identities and references; current readers accept historical values that released writers produced. API shape compatibility alone is not required. |
| Verification claims | The PR records the submitted commit, commands, observed exits and relevant limitations. Fixture results are labelled separately from live provider, tunnel or device validation; a requested or timed-out review is not an approval. |

State observations in PR descriptions: for example, “the fixture rejected an old generation” or “the command exited 0,” with the test or command that established it. Do not turn those observations into claims about untested providers or devices. The [development guide](docs/development.md#manual-verification) defines the required checks; review teams inspect snapshots and do not run them.
