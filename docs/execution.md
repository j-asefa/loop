# Execution paths

## Local control transport

[local-control.ts](../src/local-control.ts) sends JSON control requests over loopback TCP or a Unix socket. Host administration, connection-service operations and backend probes share response decoding, bounded buffering and error settlement. Responses are decoded once after collecting complete UTF-8 bytes. Callers retain their endpoint budgets: host responses allow 1,000,000 bytes, connection responses 100,000 and probes 1,000; timeout choices remain at the caller. HTTP error messages and status codes reach the caller, while malformed, oversized, interrupted or timed-out responses reject the attempt. The transport never retries a request; callers must treat a lost response to a mutation as uncertain.

The same library handles control-server dispatch, JSON replies and timing-safe authentication. Authentication compares UTF-8 byte lengths before comparing bytes. Host bodies require non-empty `application/json` and allow 100,000 bytes; connection-control bodies allow 16,000 bytes and treat an empty body as `{}`. `Problem` status and safe messages cross the boundary, while diagnostics and arbitrary exceptions do not. The relay shares JSON replies and the private probe header; its unknown-outcome and reconnecting responses retain their distinct headers.

[Local startup](../src/local-startup.ts) owns detached spawning, private log descriptors, readiness IPC, startup timeout and listener cleanup. The CLI forwards terminal interruptions only while awaiting readiness; the connection service remains in its own process group across application restarts. Callers retain their timeout messages and interpret readiness payloads, including the connection lock-busy outcome. Child entrypoints report once and disconnect IPC after sending; importing an entrypoint does not start it.

The connection service delegates application lease ownership to
[`ConnectionLeases`](../src/connection-leases.ts): generation-bound admission,
post-probe ownership checks, heartbeat expiry and recoverable detachment. The
service retains sockets, locks, relay and tunnel supervision. The registry
publishes relay changes synchronously with its decisions; its clock and probe
are dependencies. See the [lease state machine](client-state-machines.md#connection-backend-lease).

The typed [launch record](../src/launch-record.ts) owns workspace and connection
launch settings, saved workspace launch validation and subprocess argument
encoding/decoding. Start, restart and service installation read fields from that
record; the in-process connection entrypoint accepts its connection variant.
Preferences remain separate fallbacks. User CLI validation and command effects
stay in the CLI; OS service definitions receive rendered arguments. The reader
normalizes the v0.1.0 saved argv format, and writes include derived argv for
released readers; see [pairing and recovery](pairing.md).
[CLI commands](../src/cli.ts) accept parsed inputs and dependencies for state paths,
output, discovery, status and lifecycle deadlines. `main()` only parses and dispatches;
command successes return exit code zero and the entrypoint maps thrown errors as before.
`resolveStart` reads launch inputs and returns a launch decision or refusal without
persisting a launch or starting processes. The start command applies effects in their
existing order; refusals concerning a running workspace remain after connection recovery.
[Lifecycle waits](../src/lifecycle-waits.ts) supplies production defaults at the calling
boundary, and process fixtures retain the existing shortened-deadline environment inputs.
`WorkspaceHost.start` receives one object naming runtime options and lifecycle callbacks.


## Agent sources and execution environments

An agent belongs to one owner on one Loop API source and has a connection that selects its execution environment. The paired client reads each available source's owner-scoped agent, run and Feed projections and merges the Feed by activity time. Source IDs qualify agent, conversation and run identities in the client; source-scoped writes go only to the owning API. A late response from a prior signed-in owner is discarded. Project and team filters remain scoped to their source. The source's database, credentials and dispatch identities are never copied to the companion host. Opening a conversation on another source keeps the Feed mounted. The thread binds its reads, controls, uploads and file links to that source; the shell retains its original source. Drafts and pending send receipts include the owner, source and conversation, and late responses cannot overwrite the newly opened thread. Source failures appear in the thread with a retry action.

[agent-sources.ts](../src/agent-sources.ts) maps opaque source IDs to adapters. Enrolled companions use the owner-bound fleet peer adapter and remain visible during an outage, including companions running in Docker. Unknown IDs cannot nominate a network destination. The client uses the source-keyed Feed and **Run on** form to select a companion.

Linked-source metadata uses four concurrent source workers and publishes each
completed projection immediately. A slow source does not delay another source's
agents or creation choices. Failed sources retain their last loaded metadata and
are named in the connection notice. Discovery requests and source-specific
changes queued during a refresh both survive; hidden pages defer new metadata
work until foreground. Source removal stops displaying that source's cached rows.

Combined Feed head reads use four concurrent source workers with one active
read and one coalesced trailing read per source. A source can publish another
head update while another machine's read remains pending. Cold results appear
before the roster has a complete paging window; pagination starts after that
first window settles. An incomplete Working or Queued head retains its loaded
history and cursor together until the pass settles or Load more supersedes it.
An exhaustive response replaces that source immediately, including when all its
rows disappear. If the last visible rows disappear while another source is
pending, the view shows loading until that read settles; it does not claim a
complete empty result. Owner and view generations reject obsolete reads and
queued invalidations.

Needs-you cards and operational counters publish each source's successful read
independently of Done's selected agent and read filter. Needs reads share a
separate four-source queue with one coalesced trailing read per source; failed
sources retain their cached cards while healthy sources continue refreshing.

Session composer choices, quoted context, shared-link drafts and agent tabs are
qualified by authenticated owner, source and entity. They hydrate only after the
owner is known; an obsolete view cannot write after that owner's generation
changes. A fresh OS share URL belongs to the first authenticated owner opening
it. The app controller remounts on an owner-generation change; a same-owner
session refresh retains its state. Initial navigation survives the first
authentication remount, while replacement owners start without the previous
owner's URL targets. Expiry stays signed out until explicit pairing. Pending
thread draft saves flush to their captured owner before unmount; accepted sends
cancel that pending save. References held by old controller work become invalid
when the owner generation changes, including a change away and back.
Existing thread drafts and durable send identities retain their separate owning
keys.

API connections use Loop's model loop. Native connections dispatch through native adapters. Native context belongs to its harness; Loop persists the display projection, dispatch identity, approvals and tool receipts. Codex, Claude Code, Pi, Muse Code and Antigravity support live input; OpenCode, Grok Build and ACP queue follow-ups. Each native conversation has an independent session and serialized turns.

Native prompt, live-input and answer methods accept a synchronous dispatch guard from their owning runtime. Adapters recheck it immediately before native submission, including after account/configuration reads, interruption confirmation or queued preparation. A refusal prevents that submission and leaves unsent decisions pending. Callers without a guard retain their existing behavior; a guard does not replay an uncertain native effect. If Pi ends a turn with guarded input still queued, Loop preserves that native queue and reports an unconfirmed outcome. Pi exposes no durable per-entry identity, so Loop cannot safely clear and restore a queue shared with another native writer.

Core dispatch, steering, decisions and dependent work use the database-free [effect authority interface](../src/server/effect-authority.ts). Database startup installs a local guard that refuses recorded delegated work; the workspace and execution-worker composition roots install fleet authority only when enabled. Definitive non-delivery recovery and execution-grant validation use the same interface.

The internal [fleet effect store](../src/server/fleet-effect-authorizations.ts) binds creator and editor grants to an owner, effect kind and durable effect identity. Acceptance and inheritance require an owning database transaction. Revalidation checks every retained grant, including editor-only and inherited constraints. Reusing a contribution command with a different grant is refused; inheritance detects those conflicts and rolls back with its owning transaction. Definitive non-delivery recovery can discard only a newly inserted edit, inside its recovery transaction; an idempotent duplicate cannot discard a pre-existing contribution. The authenticated action context is supplied by trusted server code, never by a request header. These primitives do not mount a peer action route or install a native runtime caller by themselves.

[native-sessions.ts](../src/server/native-sessions.ts) is the stable import facade. Its [supervisor](../src/server/native/supervisor.ts) owns live sessions, generations, execution, settings, idle disposal and recovery. The same instance supplies its live-session map and callbacks to the [projector](../src/server/native/projector.ts), [decisions](../src/server/native/decisions.ts), [Pi customization](../src/server/native/pi-customization.ts) and [projects/catalogs](../src/server/native/projects.ts) modules. [Workspace preparation](../src/server/native/workspace.ts) shares the existing identity and checkout checks. Worker ownership remains at the execution authority boundary described below.

The private native tool bridge gives ordinary harness runs the same owner-scoped agent directory, direct/team mail, handoff, memory and published-file tools; delegation remains a team-manager operation and snapshot reviews keep their restricted catalog. [Agent messaging](teams.md#agent-messaging) preserves local owner isolation; direct mail and handoffs can target explicitly authorized fleet peers. Team and delegation operations remain source-local. Direct threads have two fixed participants and conversation bindings. Pending mail is durable; the atomic queue claim serializes mail against conflicting agent work and rechecks authorization before dispatch. Team mail retains membership checks. Handoffs transfer a task and context summary without transferring a provider session or additional authority, and file access is checked on forwarding and reading.

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
