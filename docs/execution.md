# Execution paths

## Local control transport

The CLI, the companion host and the connection service talk over local control requests. Each file below states its own rules in comments; read it before changing the behaviour.

| File | Owns |
| --- | --- |
| [local-control.ts](../src/local-control.ts) | Control requests and replies, response limits, secret comparison, the `Problem` boundary |
| [relay.ts](../src/relay.ts) | Forwarding to the application, the unknown-outcome and reconnecting replies |
| [local-startup.ts](../src/local-startup.ts) | Detached spawning, readiness, entrypoint detection |
| [connection-leases.ts](../src/connection-leases.ts) | Application lease ownership ([lease state machine](client-state-machines.md#connection-backend-lease)) |
| [launch-record.ts](../src/launch-record.ts) | Saved launch settings and subprocess arguments, including the v0.1.0 argv format |
| [cli.ts](../src/cli.ts) and [lifecycle-waits.ts](../src/lifecycle-waits.ts) | Commands, start decisions and lifecycle deadlines |

Across these files, one rule holds: the transport never retries a request, so every caller treats a lost response to a mutation as uncertain and inspects state before acting again.

## Agent sources and execution environments

An agent belongs to one owner on one Loop API source, and its connection selects where it runs: API connections use Loop's model loop, native connections dispatch through native adapters. Each file below states its own rules in comments.

| File | Owns |
| --- | --- |
| [agent-sources.ts](../src/agent-sources.ts) | Mapping opaque source IDs to adapters |
| [client/agentSources.ts](../src/client/agentSources.ts) and [Feed.tsx](../src/client/Feed.tsx) | Per-source metadata and Feed reads, retained data for failed sources |
| [OwnerSessionBoundary.tsx](../src/client/app/OwnerSessionBoundary.tsx) and [Session.tsx](../src/client/app/Session.tsx) | Owner-generation remounts, entry and share links, session expiry |
| [sendReceiptStore.ts](../src/client/sendReceiptStore.ts) and [Composer.tsx](../src/client/app/Composer.tsx) | Owner/source/thread-scoped send receipts and draft saves |
| [native-sessions.ts](../src/server/native-sessions.ts) and [native/supervisor.ts](../src/server/native/supervisor.ts) | Live native sessions, generations, settings, idle disposal and recovery |
| [adapters/types.ts](../src/adapters/types.ts) | The dispatch and setting guard contract adapters follow before native submission |
| [effect-authority.ts](../src/server/effect-authority.ts) | The database-free seam for dispatch, steering, decisions and dependent work |
| [native-tools.ts](../src/server/native-tools.ts) | The private tool bridge, including what a handoff does and does not transfer |

Rules that span these files:

- Source IDs qualify agent, conversation and run identities in the client, and source-scoped writes go only to the owning API. A source's database, credentials and dispatch identities are never copied to the companion host.
- Owner and view generations reject late responses from a previous owner, an obsolete view or a thread no longer open. Sources load and fail independently, and an incomplete read never shows as a complete empty result.
- Native context belongs to its harness. Loop persists only the display projection, dispatch identity, approvals and tool receipts; each native conversation has its own session and serialized turns. Live-input support per harness is in [harnesses](harnesses.md).
- A refused dispatch guard prevents the native submission and leaves unsent decisions pending; a guard never replays an uncertain native effect.
- Core callers go through the effect authority; only the workspace and execution-worker composition roots install the fleet implementation, and only when fleets are enabled ([fleet architecture](fleet-architecture.md)).
- Agent mail from the tool bridge follows [agent messaging](teams.md#agent-messaging): delegation stays a team-manager operation, team operations stay source-local, and queued mail rechecks authorization before dispatch.

## Companion execution authority

The companion host calls a private execution boundary for operations that need live native state. The authority owns the scheduler, native sessions, tool bridge, sign-ins and upgrade reservations. It runs in a child process started by the companion host over inherited Node IPC, using the same workspace data directory. Both sides validate the same operation schemas and JSON envelopes: requests have unique IDs, an authority generation, readiness checks and a limit of the public HTTP body size (12 MiB) plus 64 KiB for envelope metadata; responses have matching identities and a 64 MiB limit to accommodate native frames and their derived catalogs. Disconnect rejects outstanding requests. The client never silently switches authority or resends a command. Unknown and completed command outcomes remain explicit through the HTTP boundary, including a completed command whose cached response expired. Runtime setup, sign-in and session settings retain the original command for retries. After checking current status, the user can explicitly start a new verification, sign-in or setting request.

Trusted in-process passive workspace reads return stored model catalogs and do
not initialize projects. The fleet workspace bridge applies this context to
allowlisted reads for the authenticated destination owner. Their native requests
are limited to process status,
loaded session controls, stored runtime registrations and already loaded command
catalogs. A missing command catalog reports unavailable instead of launching a
probe. The context is internal, owner-bound and cannot be selected by request
headers; ordinary local setup and refresh requests retain their existing behavior.
Committed-event consumers leave the waking read's context before running.
Adapter catalog accessors return loaded state; ordinary local catalog and control
reads request rediscovery explicitly, while passive reads skip that refresh.

Native adapters accept an internal setting dispatch guard after validating the
revision and value, immediately before changing pending options or handing the
setting to the harness. Preflight rejection does not invoke the guard; a failure
after dispatch can still represent an uncertain effect.

The child holds an exclusive transaction on `execution/ownership.sqlite` for its entire lifetime. This separate rollback-mode SQLite file uses an [OS file lock](https://www.sqlite.org/lockingv3.html#locking); it never holds a transaction on the application database. The lock file is never unlinked and ownership has no expiry. A paused holder remains the owner. Before a replacement can recover runs, it acquires that lock, confirms the prior worker identity has exited, and stops or confirms the recorded native process groups. On Linux, namespace identity includes its init process's identity because namespace inode numbers can be reused. On macOS, a validated kernel boot-session UUID identifies the host lifetime; a copied workspace cannot supply that identity. macOS process timestamps use UTC and a fixed locale, so environment changes cannot look like PID reuse. Startup requires the current namespace and host-lifetime identity and refuses unreadable or incomplete ownership records. Unreadable identities, another PID namespace lifetime, or unidentifiable surviving groups refuse takeover and retain the records for inspection. Retained records after an unclean host reboot, container restart or workspace move have an explicit [ownership recovery procedure](pairing.md#recovering-retained-execution-ownership); a free lock alone never authorizes discarding them. Forced stop validates every process registry before signalling, preserves unreadable evidence, and retires a confirmed stopped owner while holding its lock. Graceful shutdown and replacement also remove resolved execution child and stop records under that lock. Cleanup never installs an execution generation of its own; a failed final validation preserves the original worker identity for inspection. Claims, lifecycle commands and native controls check the worker generation.

Child registration in [process-records.ts](../src/process-records.ts) declares whether Loop owns a detached process group or an attached child alone. Harnesses and execution workers register groups; cloudflared registers an individual process. Group signalling requires a recorded launch identity and refuses a different readable current identity. If the launch identity could not be read, Loop can still stop the direct child through its live child handle, but does not signal its group. Surviving group members retain the record for inspection and can keep disposal pending. This does not eliminate OS races between checking identity and sending a signal.

Harness disposal closes stdin, sends SIGTERM to the owned process group, and escalates to SIGKILL after 2.5 seconds. It resolves only after the leader has exited and the group is no longer alive. Surviving tools can still write to the project after their leader exits, so leader exit alone is insufficient. Group liveness is checked on leader exit and at one-second intervals while disposal remains pending. Processes in uninterruptible kernel sleep or running under credentials that prevent signalling can leave disposal, sign-in replacement or graceful shutdown pending indefinitely. Sending SIGKILL is not proof of termination; neither a successful timeout nor an error swallowed by sign-in cleanup safely authorizes replacement. Ownership records remain available for inspection and the [ownership recovery procedure](pairing.md#recovering-retained-execution-ownership). This check covers the owned process group, not descendants that escape into another group.

The API rejects pending IPC requests on disconnect and restarts a crashed worker with bounded backoff (250 ms to 5 seconds), including a spawn error that emits no exit event. A replacement becomes publicly ready only after restoring scheduling and origin configuration; failed restoration stops that child and retries. Coalesced origin updates have bounded reserved IPC capacity, so saturated user requests cannot silently drop an address change. Native actions are never replayed. Recovery interrupts owned native turns and preserves uncertain decisions and commands. On shutdown, claims stop before native IO is terminated. Detached native groups are recorded under `execution/`; worker shutdown, replacement and `loop stop` verify and clean them. Loss of the parent IPC channel stops the worker and its children. The API continues serving local database reads while execution is restarting; SQLite writer contention and synchronous work in API handlers remain shared limits.

| Caller                                | Authority operations                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companion routes                      | Runtime discovery, registration and enablement; sign-in catalog, status, start, input and cancellation; upgrade status, start, recovery and dismissal; native decisions and session controls/settings |
| Core routes and subscription refresh  | Native connection refresh, command catalogs, Pi trust, package filters/actions/inspection/rollback and prompt preview                                                                                 |
| Local harness setup and WorkspaceHost | Initial registration, execution startup, scheduling and shutdown                                                                                                                                      |

Database and filesystem reads such as workspace registrations, project paths, directory browsing, native history and Pi configuration remain local. Pi mutations return small acknowledgments across the boundary; the API then reads the configuration from shared database/filesystem state, preserving the complete HTTP response even for large configurations. Routes send owned identities; the authority resolves agents, conversations and connections itself. Native tool tickets and their live generation checks stay beside the supervisor. Upgrade reservations use the same authority state as queue claims, including while discovery is awaiting a probe.

Settings and enablement retain command identities across client retries. Durable receipts record intent before execution; a completed receipt can supply the prior result, while an interrupted or uncertain command is never applied again. Response bodies are retained for at most 64 commands and 4 MiB per owner; compacting a response preserves its command identity and outcome, so an old retry requires inspecting current state instead of repeating the effect. The authority also retains identities for Pi mutations and sign-in input/cancel. Those HTTP routes allocate a fresh command for each call, so their receipts do not deduplicate separate HTTP requests. Their callers must inspect current state after a lost response before issuing another action; the transport does not replay them. Routine model and status refreshes rederive the existing registration without creating command receipts.

Explicit pre-dispatch refusals release the command for retry because no native effect was attempted. Failed prompt-free verification can also be retried once its adapter has shut down, before registration changes. Native decisions and upgrades retain their existing durable identities. Sign-in receipts store a process-local keyed digest and outcome without credentials or short-lived codes; only the originating live authority can reconcile the original attempt. A new command after an unknown result requires inspecting the native state first. Sign-in attempts carry their originating command ID so recovery cannot mistake an older completed login for a requested account change; a fresh authority reloads its provider catalog during inspection when needed.

### Recipe: add an external effect

Canonical example: `executionCommand` in [execution-commands.ts](../src/server/execution-commands.ts), exercised by [execution-authority.node.test.ts](../test/execution-authority.node.test.ts). This recipe covers execution-authority commands; integration writes keyed by `request_id` follow the [write identity and replay rules](cards-api.md#write-identities-and-replay) instead.

1. Give the command a durable ID the caller supplies, and keep it across client retries and reloads.
2. In one `.immediate()` transaction, look up an existing receipt for that owner and command ID, and record intent if there is none. Do not dispatch before that transaction commits.
3. Store the current generation on the receipt. A retry in the same generation while the original request is still running in this process joins it; an unfinished receipt with no live request returns the uncertain outcome instead of running again.
4. After dispatch, record completion or `unknown`. Only an explicit pre-dispatch refusal (`ExecutionRefused`) releases the ID for retry. Do not resubmit an unknown command automatically; the caller inspects current state.
5. Record run, steering and scheduled-work effects through [effect-authority.ts](../src/server/effect-authority.ts), never its fleet implementation. Add a regression that fails after dispatch and asserts the production retry or recovery caller does not dispatch again.

Webhook delivery is a documented at-least-once exception with a stable delivery ID ([webhook deliveries](state-machines.md#webhook_deliveries-implicit)); don't copy it for other effects. If a step can't be followed, say which and why in the PR instead of working around it.
