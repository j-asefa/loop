# PR 4: signal-bound runs instead of polling

Depends on PR 2.

## Goal

Every active run polls the database for its own cancellation, and every live input path polls for its own delivery. Replace each with a shared per-run subscription to the change bus, with one slow fallback per run rather than one per consumer.

## Sites to replace (verify lines first)

| Site | Today | After |
| --- | --- | --- |
| `src/server/native-sessions.ts` native execute, ~1837 | 100 ms poll of run state to call `interrupt` | run subscription for `cancelled` and `failed` |
| `src/server/agent-runtime.ts` managed loop, ~669 | 300 ms poll of run state and connection status to abort | `AbortSignal` from the run subscription plus a `connection.status` event |
| `src/server/mcp/broker.ts` tool call, ~281 | 500 ms poll to abort | the same signal |
| `src/server/native-tool-bridge.ts` approval and delegation waits, ~144 | 200 ms loops while `awaiting_approval` | subscribe to `approval.*` and the child run's terminal events for this run |
| `src/server/steering.ts` inbox, ~155 | 100 ms pump of `run_steering` | subscribe to `steering.pending` for this run; pump on wake |
| `src/server/mcp/reverse.ts` shared-call wait, ~259 | 250 ms loop waiting for the laptop | a promise settled by completion, cancellation, revocation or deadline |
| `src/server/worker.ts` 3 s maintenance pass | timer | keep the timer for time-based work (Later, scheduled sends), and also wake it on `agent_mail.*` and `artifact.published` |

## Design

- Add `src/server/run-signal.ts` exporting `watchRun(run)`: one subscription per run id shared by every consumer in the process, reference counted, with a single 2-second fallback read per run while any consumer holds it. It exposes an `AbortSignal` that aborts with a `Problem` naming the cause on `cancelled`, `interrupted` or connection disconnection, and an `on(type, listener)` for consumers that need specific events. Every consumer releases it in `finally`.
- **Prerequisite migration, first commit of this PR.** `events.run_id` is `NOT NULL` today, and a connection can disconnect with no run. Land the minimal subject migration here rather than in PR 6: `run_id` becomes nullable and keeps its foreign key with `ON DELETE CASCADE`; add `subject_kind` and `subject_id` with the kinds `run` and `connection`; existing rows backfill as run subjects. PR 6 extends the kinds and adds the index and tombstones. Never borrow an arbitrary run id to satisfy the old schema.
- Add a `connection.status` event with the `connection` subject, emitted wherever `connections.status` is written, owner-scoped, carrying no secret material.
- The steering inbox keeps its claim-then-deliver transaction and `NotDelivered` retry semantics exactly; only the trigger changes.
- Reverse MCP: the waiting request registers a resolver keyed by call id and rechecks the row after registering, so a completion that landed between the queue write and the registration is not missed. `completeReverseCall`, cancellation, peer revocation and the deadline all settle it; an idempotently repeated call resolves every waiter. On the server profile another API process may answer; the 2-second fallback read remains the recovery.
- Native tool bridge: the approval and delegation waits are not `setInterval` but they are polling; convert them, since the acceptance criterion is absence of polling, not absence of a particular API.

## Constraints

- Never replay an uncertain effect to recover from a missed signal; the fallback read is the recovery.
- Abort reasons stay user-readable `Problem`s; the run failure trace keeps reporting phase and cause.
- No change to run state semantics or legal transitions.

## Tests

- For each replaced site: cancel through the production route; the run stops within the fallback interval with the bus disabled and well under it with the bus enabled.
- Steering: delivered once mid-turn; stays pending when the turn cannot take input; marked never delivered when racing completion.
- Reverse MCP: completion, cancellation, revocation and deadline each settle the waiter; a repeated call resolves both waiters; a completion before registration is seen.
- Tool bridge: approval decided and child run finished each wake the waiting tool call.
- Extend `test/broker-steering.test.ts` and the native turn recovery tests rather than adding parallel harnesses.

## Acceptance

No polling loop remains in `src/server` for run state, steering, approvals or reverse calls, whether written as `setInterval` or as a `setTimeout` loop, except the PR 2 `data_version` poller and the per-run fallback inside `run-signal.ts`.
