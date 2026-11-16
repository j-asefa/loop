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

The companion host calls a private execution authority for anything that needs live native state: the scheduler, native sessions, tool bridge, sign-ins and upgrade reservations. It runs as a child process over inherited Node IPC with the same data directory. Each file below states its own rules in comments.

| File | Owns |
| --- | --- |
| [execution-client.ts](../src/server/execution-client.ts) | The IPC transport, command IDs, never switching authority or resending |
| [execution-process.ts](../src/server/execution-process.ts) | Worker lifecycle: restart, readiness, the reserved lifecycle lane, IPC loss |
| [execution-authority.ts](../src/server/execution-authority.ts) | Operations and their reconciliation, including sign-in |
| [execution-commands.ts](../src/server/execution-commands.ts) | Durable receipts, bounded responses, sign-in digests |
| [execution-ownership.ts](../src/server/execution-ownership.ts) | The ownership lock, takeover and retirement of a stopped owner |
| [process-records.ts](../src/process-records.ts) | Process identity, PID-namespace and boot checks, group signalling |
| [native-spawn.ts](../src/native-spawn.ts) | Harness disposal |
| [workspace-read-context.ts](../src/server/workspace-read-context.ts) | Passive reads that never refresh runtimes |

| Caller                                | Authority operations                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companion routes                      | Runtime discovery, registration and enablement; sign-in catalog, status, start, input and cancellation; upgrade status, start, recovery and dismissal; native decisions and session controls/settings |
| Core routes and subscription refresh  | Native connection refresh, command catalogs, Pi trust, package filters/actions/inspection/rollback and prompt preview                                                                                 |
| Local harness setup and WorkspaceHost | Initial registration, execution startup, scheduling and shutdown                                                                                                                                      |

Rules that span these files:

- Native actions are never replayed. Receipts record intent before execution, an interrupted or uncertain command is never applied again, and only an explicit pre-dispatch refusal releases a command for retry.
- Unknown and completed outcomes stay explicit through HTTP, including a completed command whose cached response expired. After an unknown result the user inspects current state before starting a new command.
- A replacement worker takes over only after confirming that the previous one exited and its recorded native process groups stopped. Claims, lifecycle commands and native controls check the worker generation. Records that block takeover after a reboot, container restart or workspace move follow the [ownership recovery procedure](pairing.md#recovering-retained-execution-ownership).
- Database and filesystem reads stay in the API process, which keeps serving them while execution restarts. Routes send owned identities; the authority resolves agents, conversations and connections itself.

### Recipe: add an external effect

Canonical example: `executionCommand` in [execution-commands.ts](../src/server/execution-commands.ts), exercised by [execution-authority.node.test.ts](../test/execution-authority.node.test.ts). This recipe covers execution-authority commands; integration writes keyed by `request_id` follow the [write identity and replay rules](cards-api.md#write-identities-and-replay) instead.

1. Give the command a durable ID the caller supplies, and keep it across client retries and reloads.
2. In one `.immediate()` transaction, look up an existing receipt for that owner and command ID, and record intent if there is none. Do not dispatch before that transaction commits.
3. Store the current generation on the receipt. A retry in the same generation while the original request is still running in this process joins it; an unfinished receipt with no live request returns the uncertain outcome instead of running again.
4. After dispatch, record completion or `unknown`. Only an explicit pre-dispatch refusal (`ExecutionRefused`) releases the ID for retry. Do not resubmit an unknown command automatically; the caller inspects current state.
5. Record run, steering and scheduled-work effects through [effect-authority.ts](../src/server/effect-authority.ts), never its fleet implementation. Add a regression that fails after dispatch and asserts the production retry or recovery caller does not dispatch again.

Webhook delivery is a documented at-least-once exception with a stable delivery ID ([webhook deliveries](state-machines.md#webhook_deliveries-implicit)); don't copy it for other effects. If a step can't be followed, say which and why in the PR instead of working around it.
