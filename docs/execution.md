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
| [sendReceiptStore.ts](../src/client/sendReceiptStore.ts), [Composer.tsx](../src/client/app/Composer.tsx) and [inlineSend.ts](../src/client/inlineSend.ts) | Owner/source/thread-scoped send receipts and draft saves; a Feed card's inline reply uses the same receipt slot and signature |
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
