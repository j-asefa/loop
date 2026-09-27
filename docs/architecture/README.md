# Native execution and shared memory

Loop remains the phone/desktop application. SQLite owns conversations, queue ordering, teams, workflows, approvals and artifacts. Native connections select an execution environment (native on the laptop or Docker), provider and immutable billing policy. Their conversations bypass Loop's API model loop and attach to a durable HAPI launch/native thread. Existing conversations retain their original backend; changing an agent's connection does not silently migrate its thread.

Application services are independent API, queue, private gateway, HAPI Hub and MemSearch processes. The worker contains the controller, HAPI Runner, official Codex and Claude Code, project directories and native homes. Everything runs on the user's own machine. A worker failure leaves stored application content available; the initial application host itself remains a single point of failure.

## Status and dependencies

Application branch is stacked on [PR #2](https://github.com/j-asefa/loop/pull/2), including `137b82b` (final answers/traces and recoverable tool errors). Loop, HAPI and MemSearch run locally; there are no cloud components.

Local evidence is recorded in [EVIDENCE.md](EVIDENCE.md). Native subscription execution, provider authentication, the complete phone journey and restart/restore checks remain unverified. The release is a draft pending those gates.

## State and authorization

Migrations 020/021 are additive and coexist with upstream migration 018. They add environment/project mappings, native sessions and dispatch receipts, projected-message revisions, native permissions, memory source revisions/outbox/policies/tombstones, versioned notes and uploaded object references. Provider credentials never enter these tables. Per-session gateway and environment secrets are encrypted using the existing Loop encryption key; preserve that key during migration.

Only operator provisioning registers an environment. The configuration binds its expected instance identity, private hostname, namespace, certificate fingerprint and independently revocable credential. Locally generated identities and operator-delivered secrets establish that binding; there is no public self-enrollment endpoint accepting an asserted machine name. Repeating identical provisioning is idempotent; replacing an instance/certificate or reusing a revoked identity fails closed. Worker HTTP/WebSocket traffic passes the mTLS gateway and namespace check. A copied Hub token alone is insufficient. Revocation closes proxy connections and refuses subsequent gateway/Hub access; it does not claim a partitioned native process stopped.

Codex launches force `forced_login_method=chatgpt` and `model_provider=openai`. Ambient model/cloud API credentials are stripped. The actual managed app-server checks fresh account/config status before execution methods, including native queue submission and cold resume. Cached API, unknown and missing auth fail closed. There is no API adapter fallback. Explicit Claude workers retain their own pinned native policy when delegated; this does not reroute a Codex run to Claude. Native Claude sign-in is independently checked through the official status interface. Provider allowance/extra-credit settings remain provider-controlled.

Dispatch receipts precede spawn/send. A send compare-and-swap and persisted send-start marker prohibit concurrent replay. Lost spawn acknowledgements can attach only to one matching launch; once a send could have occurred, absence of output is not permission to resend. Native completion must identify the accepted local ID, native turn and thread. SSE checkpoints follow durable REST projection. Full compound-cursor/epoch backfill precedes history checkpoints. Invalidated messages remain as superseded history and are suppressed from recall until rebuilt. Native updates use the existing trace surface, while final results become normal Loop answers/artifacts.

Native and Loop tool approvals use distinct request identities. A submitted native decision remains pending acknowledgment; an expired request is denied once, never implicitly approved. Cancellation remains requested until native completion/interruption is observed. MCP calls reuse the existing tool broker, approval policies and delegation budgets. Uncertain matching external tool effects cannot be retried under a new request ID.

## Memory and files

Managed native conversations are visibly included by default. Historical/API conversations require explicit inclusion. Project scope and promoted workspace notes bound automatic recall. Explicit cross-project gateway queries require a project owned by the same workspace. Tools never choose an account/session identity. Recall includes original source links, roles, revisions and timestamps, and is labeled untrusted historical evidence. It cannot authorize current actions.

MemSearch 0.4.21 runs as one writer with its pinned local ONNX BGE-M3 weights. The service cannot reach external networks. It does not call summarizers or remote embeddings. Scope, inclusion, revision and tombstone checks occur again in Loop before returning any candidate; stale vectors cannot resurrect removed content. Automatic retrieval has a 1.5-second deadline, at most five sources and a 6,000-character envelope cap. Degraded keyword/no-memory status and approximate token receipts are visible. HAPI truncation markers remain visible and completeness is recorded. Removing recall leaves original conversation history and previously delivered context intact.

Pinned notes keep prior versions. The durable outbox is safe to replay; source IDs and increasing revisions prevent stale jobs replacing newer data. Selected source documents have one embedding writer. Ordinary Loop search and explicitly configured API paths remain supported.

`loop_publish_file` reads an explicitly selected project file through its bound worker session, rejects unsafe paths/dotfiles and unsupported types, limits size to 10 MiB and checks hashes. The application writes it once to a content-addressed private `objects/*` path under its data directory and confirms stored size/hash before publishing an artifact. Workers never receive direct storage access. Downloads are served only after owner authorization. Worker-only paths remain unavailable during an outage.

## Pinned upstream seams

[versions.json](../../deployment/versions.json) pins HAPI commit `0239edf`, official Codex 0.157.0, Claude Code 2.1.280, Bun 1.4.0, MemSearch commit `2a4652f`, model revision and container bases. `native/apply-hapi-patch.mjs` applies only to that HAPI commit and rejects missing contexts. It adds launch correlation, instructions/MCP injection, actual-process auth enforcement, lifecycle attribution and namespace guards. Peer memory bypass tools and unused tunnel packaging are disabled. Re-run compatibility/transport checks before changing pins.

HAPI is AGPL-3.0-only; MemSearch is MIT. The native image includes upstream license/notice, an exact source archive, patch and patch authoring files under `/opt/native/licenses` and `/opt/loop-native`. Preserve this corresponding source with distribution and offer it to users interacting with the modified HAPI service. The Loop repository's existing license is not a claim that upstream licensing obligations disappear.

## Limits requiring validation

This is a single-owner pilot, not hardened cross-customer execution. Approved start directories and file-upload restrictions do not confine arbitrary native shell commands to one project. Native processes share the worker OS identity; project isolation beyond gateway checks needs a stronger OS boundary. Native homes/auth and repository state must stay on encrypted retained storage.

Resident sessions consume capacity while idle or awaiting approval. Loop exposes release of a completed idle process and explicit resume; automatic idle reclamation is intentionally disabled until real provider resume is verified. Concurrent-session/tool memory and host sizing are not established by the fixture tests. MemSearch recall met the small synthetic accuracy target, but emulated warm latency missed the target and did not outperform the existing baseline. No quality or performance improvement is claimed.
