# Architecture

Loop has one React UI, workspace API and SQLite migration set, with two authorization profiles. The companion profile uses device pairing and a local host-owned worker. The server profile uses local/gateway/account access and an independently runnable worker. Runtime selection is separate from authorization profile.

## Source map

| Boundary                                                  | Production source                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CLI and managed laptop provisioning                       | [cli.ts](../src/cli.ts), [local-runtime.ts](../src/local-runtime.ts)                                                          |
| Companion host, worker ownership and device authorization | [workspace-host.ts](../src/workspace-host.ts), [host.ts](../src/host.ts)                                                      |
| Server entrypoints and routes                             | [serve.ts](../src/server/serve.ts), [worker.ts](../src/server/worker.ts), [index.ts](../src/server/index.ts)                  |
| Profile and owner access                                  | [profile.ts](../src/server/profile.ts), [access.ts](../src/server/access.ts), [auth.ts](../src/server/auth.ts)                |
| Queue and managed model/tool loop                         | [queue.ts](../src/server/queue.ts), [agent-runtime.ts](../src/server/agent-runtime.ts)                                        |
| Direct native sessions and adapters                       | [native-sessions.ts](../src/server/native-sessions.ts), [adapters](../src/adapters)                                           |
| Managed native execution                                  | [hapi](../src/server/hapi), [native](../native), [deployment](../deployment)                                                  |
| Server subscription/native-host transport                 | [subscriptions.ts](../src/server/subscriptions.ts), [runtime-hosts.ts](../src/server/runtime-hosts.ts), [runtime](../runtime) |
| Database and migrations                                   | [db.ts](../src/server/db.ts), [migrations](../migrations)                                                                     |
| Feed, reading position, Later and scheduled sends         | [mobile-return.ts](../src/server/mobile-return.ts), [mobile-routes.ts](../src/server/mobile-routes.ts)                        |
| Your profile (name, handle, bio, counts) and sent prompts | [user-profile.ts](../src/server/user-profile.ts), [personal-history.ts](../src/server/personal-history.ts)                    |
| UI and shared contracts                                   | [client](../src/client), [shared](../src/shared)                                                                              |

## Execution paths

API-provider and server subscription connections use Loop's managed queue and conversation context. Managed work is serialized per agent, except HAPI connections, which serialize turns per conversation and allow concurrent conversations bounded by environment capacity. Subscription runtimes receive Loop's bounded history and structured tool/answer contract while retaining their native tools.

Direct companion connections route to durable native sessions before the managed model loop. Independent conversations can run concurrently; each conversation serializes its work and binds an immutable connection, project and native session. Native history owns context; Loop stores a display projection. Idle direct processes may be evicted and resumed using native session IDs. The managed HAPI backend has its own explicit release/resume lifecycle; do not infer its policy from the direct adapter host.

HAPI is an active execution backend, with a private Hub, gateway and runners. The launcher can place runners natively or in Docker; the local server Compose stack also uses HAPI. mTLS, namespaces, provisioned identities and revocable credentials protect its control plane. Native processes still run with their OS user's access; project selection is not shell confinement.

Follow-ups and steering retain durable input identities. Before external dispatch, Loop records intent; an uncertain send is never automatically replayed. Native approvals and cancellation belong to the owning conversation/generation. A setting request is not an effective setting until the runtime confirms it. Rebinding an agent does not silently migrate old conversations.

Companion updates use replayable WebSockets with epochs/cursors and polling recovery; server views use bounded polling. Both render the same workspace projections. A private generation-bound native tool bridge rechecks permissions and expires with its owner.

## Activities

Plans, tool lifecycle, diffs, command output, settings and command catalogs share [agent-activities.ts](../src/agent-activities.ts). [server/activities.ts](../src/server/activities.ts) validates and persists trusted owner/conversation/run scope and serves paginated projections. [activity-bridge.ts](../src/activity-bridge.ts) supplies the shared direct mapping used by live adapters, native history and subscription runtime activity ingestion.

The client uses [activityView.ts](../src/client/activityView.ts) to accumulate full snapshot pages and apply incremental updates. Read-only projections of older trace rows preserve old history without executing it again. Activities are display data: Loop never applies a reported diff or uses these records as native model context.

Records are bounded, versioned and keyed by producer identity. Sequence/revision checks prevent stale updates overwriting newer state; generation checks reject stale producers. Re-delivery is idempotent. Replay does not advance live tool lifecycle. Capabilities distinguish supported, unsupported and undiscovered behavior instead of fabricating results.

## Memory, tools and files

Workspace MCP connections belong to the owner and are shared by that owner's agents. Broker dispatch checks discovery, schema, ownership, connection and approval state. Companion command MCPs use local subprocesses; server command MCPs use runtime infrastructure. Rich MCP Apps run in isolated iframes. See [workspace](workspace.md).

Search supports keyword and optional semantic indexing. Managed native recall uses [memory.ts](../src/server/memory.ts) and the optional MemSearch service; laptop startup can run without it. Scope, inclusion, revision and tombstone checks apply again before returning indexed candidates. Recall is untrusted historical evidence, never current authorization. Versioned notes and an outbox preserve update ordering.

Message attachments reach the model as file references read through `loop_read_file`. API-key connections also receive the current turn's images and PDFs inline. Before a broker turn, the current turn's uploads are copied into the runtime in checksummed chunks: under `.loop/uploads/` in the agent workspace on managed containers, or under the host user's `~/.loop/uploads/` on a native host. The prompt then lists their paths so native tools open them directly. If a copy fails, the turn continues with `loop_read_file` only. Codex app-server hosts do not receive copies yet.

File publication validates the selected file/path, size and digest, then stores private content under the workspace data directory. Downloads require owner access. A worker path alone is not a published file. Credentials remain in encrypted server storage or their native provider homes; neither belongs in public projections.

## Dependencies and boundaries

[deployment/versions.json](../deployment/versions.json) owns managed HAPI, provider and MemSearch pins. [host-control.ts](../src/host-control.ts) owns direct harness checks. [package.json](../package.json) pins the ACP SDK. Validate each seam when updating it.

HAPI is AGPL-3.0-only and MemSearch is MIT. Preserve upstream notices and corresponding modified HAPI source/patch material in distributions; the native image carries these under `/opt/native/licenses` and `/opt/loop-native`. The repository's package license does not replace upstream obligations.

The application host is a single point of failure. Native tools are not a multi-tenant sandbox. Fixture tests establish protocol behavior, not provider availability, billing entitlement, device acceptance or deployment capacity. See [development](development.md) for verification boundaries.
