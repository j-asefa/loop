# Execution paths

How requests reach the companion's processes, agent sources and native harnesses. Each section names the files that own the mechanism and lists the rules that no single file shows. Limits, timeouts and call order live in the code; read the owning file for them.

## Local control transport

Owners: [local-control.ts](../src/local-control.ts) (control requests, dispatch, authentication), [local-startup.ts](../src/local-startup.ts) (detached spawning and readiness), [connection-leases.ts](../src/connection-leases.ts) (application lease; see the [lease state machine](client-state-machines.md#connection-backend-lease)), [launch-record.ts](../src/launch-record.ts) (saved launch settings), [cli.ts](../src/cli.ts) and [lifecycle-waits.ts](../src/lifecycle-waits.ts).

- The transport never retries a request. Callers treat a lost response to a mutation as uncertain.
- Malformed, oversized, interrupted or timed-out responses reject the attempt. Each caller keeps its own response budget and timeout.
- Only `Problem` status and safe messages cross the boundary; diagnostics and arbitrary exceptions do not. Authentication is timing-safe.
- The connection service stays in its own process group across application restarts. The CLI forwards terminal interruptions only while awaiting readiness. Importing a child entrypoint does not start it.
- The launch record owns saved launch settings and subprocess arguments. Its reader normalizes the v0.1.0 saved argv format, and writes still include derived argv for released readers ([pairing and recovery](pairing.md)).
- `resolveStart` returns a launch decision or refusal without persisting a launch or starting processes; `main()` only parses and dispatches.

## Agent sources and execution environments

An agent belongs to one owner on one Loop API source, and its connection selects the execution environment: API connections use Loop's model loop, native connections dispatch through native adapters. [agent-sources.ts](../src/agent-sources.ts) maps opaque source IDs to adapters. [native-sessions.ts](../src/server/native-sessions.ts) is the import facade over the [native supervisor](../src/server/native/supervisor.ts), which owns live sessions, generations, settings, idle disposal and recovery.

- Source IDs qualify agent, conversation and run identities in the client. Source-scoped writes go only to the owning API, and an unknown source ID cannot nominate a network destination.
- A source's database, credentials and dispatch identities are never copied to the companion host.
- Owner and view generations reject late responses from a previous owner, an obsolete view or a thread no longer open. Drafts, pending send receipts, composer choices and agent tabs are keyed by owner, source and entity.
- Sources load and fail independently. A slow or failed source never delays another, a failed source keeps its last loaded data, and an incomplete read never shows as a complete empty result.
- Native context belongs to its harness. Loop persists only the display projection, dispatch identity, approvals and tool receipts. Each native conversation has its own session and serialized turns. Codex, Claude Code, Pi, Muse Code and Antigravity accept live input; OpenCode, Grok Build and ACP queue follow-ups.
- Native prompt, live-input, answer and setting methods recheck their runtime's dispatch guard immediately before submission. A refusal leaves unsent decisions pending, and a guard never replays an uncertain native effect. If Pi ends a turn with guarded input still queued, Loop reports an unconfirmed outcome: Pi has no per-entry identity that would let Loop clear and restore a queue shared with another writer.
- Core dispatch, steering, decisions and dependent work go through the database-free [effect authority](../src/server/effect-authority.ts). Only the workspace and execution-worker composition roots install fleet authority, and only when fleets are enabled; fleet grants are in [fleet-effect-authorizations.ts](../src/server/fleet-effect-authorizations.ts) and [fleet architecture](fleet-architecture.md).
- The private native tool bridge gives harness runs the same owner-scoped agent directory, mail, handoff, memory and published-file tools. Delegation stays a team-manager operation, team operations stay source-local, and pending mail rechecks authorization before dispatch ([agent messaging](teams.md#agent-messaging)). Handoffs transfer a task and context summary, never a provider session or additional authority.

## Companion execution authority

The companion host calls a private execution authority for anything that needs live native state: the scheduler, native sessions, tool bridge, sign-ins and upgrade reservations. It runs as a child process over inherited Node IPC with the same data directory. Owners: [execution-client.ts](../src/server/execution-client.ts), [execution-authority.ts](../src/server/execution-authority.ts), [execution-commands.ts](../src/server/execution-commands.ts) and [process-records.ts](../src/process-records.ts).

| Caller                                | Authority operations                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companion routes                      | Runtime discovery, registration and enablement; sign-in catalog, status, start, input and cancellation; upgrade status, start, recovery and dismissal; native decisions and session controls/settings |
| Core routes and subscription refresh  | Native connection refresh, command catalogs, Pi trust, package filters/actions/inspection/rollback and prompt preview                                                                                 |
| Local harness setup and WorkspaceHost | Initial registration, execution startup, scheduling and shutdown                                                                                                                                      |

Database and filesystem reads (workspace registrations, project paths, directory browsing, native history, Pi configuration) stay in the API process. Routes send owned identities; the authority resolves agents, conversations and connections itself.

**Commands and outcomes**

- Both sides validate the same operation schemas. Requests carry unique IDs and the authority generation; disconnect rejects outstanding requests. The client never silently switches authority or resends a command.
- Native actions are never replayed. Durable receipts record intent before execution, and an interrupted or uncertain command is never applied again. Only an explicit pre-dispatch refusal releases a command for retry.
- Unknown and completed outcomes stay explicit through HTTP, including a completed command whose cached response expired. After an unknown result, the user inspects current state before starting a new command.
- Retained response bodies are bounded, but compaction keeps each command's identity and outcome. Pi mutations and sign-in input or cancel allocate a fresh command per HTTP call, so their callers inspect state after a lost response.
- Sign-in receipts store a keyed digest and outcome, never credentials or short-lived codes.
- Passive reads, including fleet workspace reads, return stored state and never launch a probe or initialize a project. Their context is internal and cannot be selected by request headers.

**Worker ownership and processes**

- The worker holds an exclusive lock on `execution/ownership.sqlite` for its whole lifetime, never on the application database. Ownership has no expiry, and a free lock alone never authorizes discarding retained records.
- A replacement takes over only after confirming that the previous worker has exited and its recorded native process groups are stopped. Unreadable or mismatched identities refuse takeover and keep the records for the [ownership recovery procedure](pairing.md#recovering-retained-execution-ownership). Claims, lifecycle commands and native controls check the worker generation.
- A process group is signalled only when its recorded launch identity matches. Disposal finishes only when the leader has exited and its group is gone, because surviving tools can still write to the project; sending SIGKILL is not proof of termination.
- A crashed worker restarts with bounded backoff and becomes ready only after restoring scheduling and origin configuration. Recovery interrupts owned native turns and preserves uncertain decisions and commands. The API keeps serving local reads while execution restarts.

### Recipe: add an external effect

Canonical example: `executionCommand` in [execution-commands.ts](../src/server/execution-commands.ts), exercised by [execution-authority.node.test.ts](../test/execution-authority.node.test.ts). This recipe covers execution-authority commands; integration writes keyed by `request_id` follow the [write identity and replay rules](cards-api.md#write-identities-and-replay) instead.

1. Give the command a durable ID the caller supplies, and keep it across client retries and reloads.
2. In one `.immediate()` transaction, look up an existing receipt for that owner and command ID, and record intent if there is none. Do not dispatch before that transaction commits.
3. Store the current generation on the receipt. A retry in the same generation while the original request is still running in this process joins it; an unfinished receipt with no live request returns the uncertain outcome instead of running again.
4. After dispatch, record completion or `unknown`. Only an explicit pre-dispatch refusal (`ExecutionRefused`) releases the ID for retry. Do not resubmit an unknown command automatically; the caller inspects current state.
5. Record run, steering and scheduled-work effects through [effect-authority.ts](../src/server/effect-authority.ts), never its fleet implementation. Add a regression that fails after dispatch and asserts the production retry or recovery caller does not dispatch again.

Webhook delivery is a documented at-least-once exception with a stable delivery ID ([webhook deliveries](state-machines.md#webhook_deliveries-implicit)); don't copy it for other effects. If a step can't be followed, say which and why in the PR instead of working around it.
