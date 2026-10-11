# Shared lifecycle implementation guide

Read [architecture](../../docs/architecture.md), then load [harnesses](../../docs/harnesses.md) or [server operation](../../docs/server.md) only for the execution paths you touch. The locations below are investigation starting points; verify them against the checkout.

## Production boundaries

| Concern                                                             | Starting points                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Adapter event contract and capabilities                             | `src/protocol.ts`, `src/adapters/types.ts`, `src/adapters/`                                            |
| Session ownership, event ingestion, output projection, idle cleanup | `src/server/native-sessions.ts`                                                                        |
| Run creation, claims, transitions, heartbeats, recovery             | `src/server/queue.ts`, `src/server/worker.ts`, `src/server/agent-runtime.ts`                           |
| Other native execution paths                                        | `src/server/subscriptions.ts`, `src/server/runtime-hosts.ts`, `runtime/`, `src/host.ts`                |
| Workspace tools and decision authority                              | `src/server/native-tool-bridge.ts`, `src/server/native-tools.ts`, and their session lookups            |
| Feed and transcript projections                                     | `src/server/mobile-return.ts`, `src/server/conversation-messages.ts`, relevant `src/client/` consumers |
| Existing background result delivery                                 | `src/server/agent-mail.ts`                                                                             |
| Durable schema                                                      | `migrations/`, `src/server/db.ts`                                                                      |

At assignment preparation, `NativeSessions.event()` records items received without `live.run` as history and does not adopt a run from a running status. `execute()` clears `live.run` and schedules disposal after 60 seconds; session allocation also evicts sessions without a run. Pi, Codex, and OpenCode already emit some running statuses, while Claude completion is guarded against foreign results. The Feed already selects active work separately from the latest completed result. Recheck these facts before changing code.

## Suggested structure

Separate native session lifetime from the lifetime of a Loop run. Introduce a normalized execution lifecycle with a correlated start and terminal event, explicit live/replay provenance, and background-work state where available. Exact type names and storage layout are implementation choices. Avoid overloading uncorrelated `status: running` events that may also describe startup or reconciliation.

Factor the shared run setup and completion behavior so both prompted execution and observed continuation use it. The observed path creates a durable running record and attaches monitoring to existing execution; it must never enter a dispatch path that submits a prompt. Preserve normal output checkpoints, artifact creation, activity attribution, approvals, final results, and notifications without copying stale trigger-specific payloads from the previous run, such as a workflow step or mail receipt.

Adoption must be atomic with identity reservation and ownership. Integrate it with worker heartbeats, concurrency accounting, scheduling, recovery, and shutdown. A run that only looks active in SQL but has no supervisor is insufficient. At preparation time the Feed interprets a running run without a worker as waiting for children; account for that projection rather than accidentally using an unowned run as a shortcut.

## Races that the design must settle

- A terminal event and the next native start can arrive in one transport burst, before the previous `execute()` promise's `finally` runs. Old cleanup must not clear the newly adopted run, approvals, output buffers, or timers.
- Native starts may arrive before a prompt's acceptance response. Bind them to the submitted run rather than creating an observed duplicate.
- A queued prompt may be claimed just as an autonomous turn starts. Serialize native dispatch and event adoption, and preserve the queued input without replaying anything already delivered or uncertain.
- Child completion does not prove that the parent has processed the result. Retention must bridge that gap without inventing a Working card.
- Reconnect snapshots may describe ongoing execution or replay completed output. Use stable identities and verified state to distinguish them; do not create a fresh run for each snapshot.
- Late events from a cancelled turn or replaced generation must not complete a later run or resolve its approvals.

## Retention and compatibility

Model known outstanding work, known quiescence, and unknown background state separately. Use documented harness signals or supported extension integration where possible. For unknown state, select and document an explicit policy that supports delayed wakeups, accounts for retained-process capacity, and provides a deliberate cleanup path. A larger arbitrary idle timeout alone does not solve the problem. Resource pressure must not silently kill sessions required for background completion.

Audit serializers, runtime transports, and the legacy host when adding event variants. Keep wire contracts and capabilities consistent; internal lifecycle records must not accidentally become browser authority. Retain owner/profile isolation and generation checks at every production ingress. If schema changes are necessary, add forward migrations and migration regressions; do not reinterpret existing uncertain dispatches as safe to resume.

Document implemented semantics in the existing canonical architecture/harness guides and link between them. Keep unsupported capabilities, restart limitations, and retention policy precise. Do not copy this proposal into product documentation as though it were already implemented.
