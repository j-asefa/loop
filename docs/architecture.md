# Architecture

Loop has one React UI, workspace API and SQLite migration set, with two authorization profiles. The companion profile uses device pairing and a local host-owned worker. The server profile uses local/gateway/account access and an independently runnable worker. Runtime selection is separate from authorization profile.

## Source map

| Boundary                                                  | Production source                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CLI and native harness discovery                       | [cli.ts](../src/cli.ts), [local-harnesses.ts](../src/server/local-harnesses.ts)                                                          |
| Companion host, worker ownership and device authorization | [workspace-host.ts](../src/workspace-host.ts), [host.ts](../src/host.ts)                                                      |
| Agent-source discovery and paired proxy                   | [agent-sources.ts](../src/agent-sources.ts), [linked-docker.ts](../src/linked-docker.ts)                                       |
| Server entrypoints and routes                             | [serve.ts](../src/server/serve.ts), [worker.ts](../src/server/worker.ts), [index.ts](../src/server/index.ts)                  |
| Profile and owner access                                  | [profile.ts](../src/server/profile.ts), [access.ts](../src/server/access.ts), [auth.ts](../src/server/auth.ts)                |
| Queue and managed model/tool loop                         | [queue.ts](../src/server/queue.ts), [agent-runtime.ts](../src/server/agent-runtime.ts)                                        |
| Legacy native history and compatibility                       | [native-sessions.ts](../src/server/native-sessions.ts), [adapters](../src/adapters)                                           |
| Native execution                                  | [native-sessions](../src/server/native-sessions.ts), [adapters](../src/adapters), [subscriptions](../src/server/subscriptions.ts)                                                  |
| Server subscription/native-host transport                 | [subscriptions.ts](../src/server/subscriptions.ts), [runtime-hosts.ts](../src/server/runtime-hosts.ts), [runtime](../runtime) |
| Database and migrations                                   | [db.ts](../src/server/db.ts), [migrations](../migrations)                                                                     |
| Feed (thread list, `/api/feed`), reading position, Later and scheduled sends | [mobile-return.ts](../src/server/mobile-return.ts), [mobile-routes.ts](../src/server/mobile-routes.ts) |
| Results stream (result cards and files, `/api/results`)   | [results.ts](../src/server/results.ts), [core-routes.ts](../src/server/core-routes.ts)                                         |
| Your profile (name, handle, bio, counts) and sent prompts | [user-profile.ts](../src/server/user-profile.ts), [personal-history.ts](../src/server/personal-history.ts)                    |
| UI and shared contracts                                   | [client](../src/client), [shared](../src/shared)                                                                              |

## Execution paths

### Agent sources and execution environments

An agent belongs to one owner on one Loop API source and has a connection that selects its execution environment. The paired client reads each available source's owner-scoped agent, run and Feed projections and merges the Feed by activity time. Source IDs qualify agent, conversation and run identities in the client; source-scoped writes go only to the owning API. A late response from a prior signed-in owner is discarded. Project and team filters remain scoped to their source. The source's database, credentials and dispatch identities are never copied to the companion host. Opening a conversation on another source keeps the Feed mounted. The thread binds its reads, controls, uploads and file links to that source; the shell retains its original source. Drafts and pending send receipts include the owner, source and conversation, and late responses cannot overwrite the newly opened thread. Source failures appear in the thread with a retry action.

[agent-sources.ts](../src/agent-sources.ts) maps opaque source IDs to adapters. Its current Docker adapter discovers only local loopback-published single-user Loop containers and forwards paired requests once. Unknown IDs cannot nominate a network destination. [MCP Docker sharing](../src/mcp-docker-sharing.ts) separately enrolls a discovered source after an explicit paired-device action. Source-owned tools are exposed through a token-scoped MCP endpoint or a reverse queue polled by the laptop; no companion API is bound beyond loopback for sharing. The calling broker applies its owner's approval preference; the owning source rechecks its tool catalog and schema. Both sides persist call identities and uncertain outcomes rather than replaying effects. Other Loop hosts need an adapter with secure discovery/enrollment and owner authorization; remote runtime hosts connected to a Loop source are accessed through that source. The client uses the same source-keyed Feed and **Run on** form regardless of adapter kind.

API connections use Loop's model loop. Native connections dispatch through native adapters, and server subscription connections through their configured runtime. Native context belongs to its harness; Loop persists the display projection, dispatch identity, approvals and tool receipts. Codex, Claude Code and Pi support live input; OpenCode, Gemini CLI and ACP queue follow-ups. Each native conversation has an independent session and serialized turns.

The private native tool bridge gives ordinary harness runs the same owner-scoped agent directory, direct/team mail, handoff, memory and published-file tools; delegation remains a team-manager operation and snapshot reviews keep their restricted catalog. [Agent messaging](workspace.md#agent-messaging) stays within one owner and Loop API source. Direct threads have two fixed participants and conversation bindings. Pending mail is durable; the atomic queue claim serializes mail against conflicting agent work and rechecks authorization before dispatch. Team mail retains membership checks. Handoffs transfer a task and context summary without transferring a provider session or additional authority, and file access is checked on forwarding and reading.

An earlier release ran harnesses through HAPI; that code is gone. Migration 080 made its leftover records inert once: active HAPI runs were interrupted without replay and their pending approvals rejected, HAPI connections stay disconnected and no longer present as subscriptions, and HAPI conversations keep their memory inclusion as an explicit policy. Their history remains readable. No uncertain external effect is replayed automatically.

## Workspace updates

The signed-in UI subscribes to authenticated WebSockets for each execution source. The server profile exposes `/api/events/ws`; the paired host also retains `/ws` and forwards source event connections through its existing discovery and device authorization boundary. Cards integration tokens cannot open these connections. Run-event cursors and owner-scoped Cards revision watermarks notify Feed, Working and Done when committed data changes, including saves and dismissals without a run event. The API observes the shared SQLite database so updates from a separate worker are included.

Notifications prompt bounded HTTP reads through the existing pagers; they preserve loaded history and per-source cursors. An update arriving during a Feed read schedules a follow-up. Reconnects reconcile missed changes, and a different server epoch resets the event cursor. Oversized event replay batches send a reset at the latest owner watermark, prompting HTTP reconciliation without changing the stored events. Unavailable sockets and older sources fall back to HTTP event polling. Periodic Feed refreshes and phone-wake refreshes also catch time-based changes. Neither transport replays commands or other writes.

## Activities

Plans, tool lifecycle, diffs, command output, settings and command catalogs share [agent-activities.ts](../src/agent-activities.ts). [server/activities.ts](../src/server/activities.ts) validates and persists trusted owner/conversation/run scope and serves paginated projections. [activity-bridge.ts](../src/activity-bridge.ts) supplies the shared mapping for native activity projections and historical records.

The client uses [activityView.ts](../src/client/activityView.ts) to accumulate full snapshot pages and apply incremental updates. Read-only projections of older trace rows preserve old history without executing it again. Conversation transcripts show human messages and public agent output, including progress updates. Tool calls, raw native events and activity records stay out of the transcript, except native failure and uncertain-delivery notices. Tool calls, command output and plan progress are available from the conversation's **Tool activity** option, including managed native tool activity that arrived outside a Loop turn; saved tool traces are in the agent profile’s Traces tab. Session settings stay in **Session settings**. A link to a hidden row opens the conversation where that row was. Activities are display data: Loop never applies a reported diff or uses these records as native model context.

[Conversation transcripts](../src/server/conversation-messages.ts) page through an indexed display projection whose ordering keys are maintained in the same transaction as messages. Public assistant updates live in the message store with idempotent per-run producer keys; transcripts, reply quotes and reading positions do not read execution traces. Migration 073 copies older public updates into messages while preserving their IDs and ordering cursors. Message sequences remain stable through deletion and database compaction. A run's updates group under its prompt, or under the run's first stored message when imported or replayed history has none. The page is selected before loading its content and current run/delivery state. Opening a thread loads confirmed session controls and file summaries. Opening **Tool activity** loads its recent activity snapshot; **Load earlier activity** requests older records, including legacy traces, and is offered only while older records that view can show remain. File-change records are loaded for runs in the displayed transcript so older result chips retain their file reviews. Activity history and live-update cursors are independent.

Records are bounded, versioned and keyed by producer identity. Sequence/revision checks prevent stale updates overwriting newer state; generation checks reject stale producers. Re-delivery is idempotent. Replay does not advance live tool lifecycle. Capabilities distinguish supported, unsupported and undiscovered behavior instead of fabricating results.

## Memory, tools and files

Workspace MCP connections belong to the owner and are shared by that owner's agents. Broker dispatch checks discovery, schema, ownership, connection and approval state. Companion command MCPs use local subprocesses; server command MCPs use runtime infrastructure. Rich MCP Apps run in isolated iframes. See [workspace](workspace.md).

Search supports keyword and optional semantic indexing. Managed native recall uses [memory.ts](../src/server/memory.ts) and the optional MemSearch service; laptop startup can run without it. Artifact content and versions remain live during streaming, but artifact search indexes retain their last indexed snapshot until the partial flag clears; failed or paused partial drafts retain that snapshot until finalized. Results revisions likewise skip repeated partial updates. Scope, inclusion, revision and tombstone checks apply again before returning indexed candidates. Recall is untrusted historical evidence, never current authorization. Versioned notes and an outbox preserve update ordering.

Message attachments reach the model as file references read through `loop_read_file`. Before upload, the browser scales HEIC photos and images over 1.5 MB to at most 2048 pixels on the longest side and re-encodes them as JPEG ([imageUpload.ts](../src/client/imageUpload.ts)); GIFs, SVGs and images it cannot decode are sent unchanged. An upload error that is not Loop's JSON (a tunnel or proxy page) is shown with its HTTP status. API-key connections also receive the current turn's images and PDFs inline. Native turns receive upload references and use `loop_read_file` through the private tool bridge.

File publication validates the selected file/path, size and digest, then stores private content under the workspace data directory. Downloads require owner access. A worker path alone is not a published file. Credentials remain in encrypted server storage or their native provider homes; neither belongs in public projections.

## Dependencies and boundaries

[deployment/versions.json](../deployment/versions.json) owns container provider and MemSearch pins. [host-control.ts](../src/host-control.ts) owns installed harness version checks. [package.json](../package.json) pins the ACP SDK. Validate each seam when updating it.

Dependencies retain their upstream licenses.

The application host is a single point of failure. Native tools are not a multi-tenant sandbox. Fixture tests establish protocol behavior, not provider availability, billing entitlement, device acceptance or deployment capacity. See [development](development.md) for verification boundaries.
