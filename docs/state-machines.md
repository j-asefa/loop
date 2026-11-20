# State machines

This is the canonical list of Loop's stateful records and in-memory session
objects: their states, the invariants each state carries, and every
transition with the code that performs it and the guard that makes it safe.
Client and host machines are on their own page, [client and host state
machines](client-state-machines.md). The last section lists invalid states or
transitions the code could reach on either page, with their status. Update the relevant table in the same change that adds a
state, an edge or a writer.

## Conventions

The API and the worker are separate processes sharing one SQLite database
through better-sqlite3, which is synchronous. A read and a write with no
`await` between them, inside one `.immediate()` transaction, cannot interleave
with another process. Any `await` between a read and a dependent write is a
window. The guard column uses these terms:

| Guard | Meaning |
| ----- | ------- |
| **tx** | The writer re-reads the row and checks its state inside the same immediate transaction. |
| **sql** | The `UPDATE` itself requires the prior state (`WHERE state=…`), so a stale caller changes nothing. |
| **lease** | The write also requires the caller's lease, token, attempt or generation. |
| **mem** | Only in-process state guards the write; correct only while one process owns the object. |
| **trigger** | A database trigger in `migrations/` performs or constrains the transition. |

Terminal states are written in **bold**.

## Recipe: add a state or transition

Canonical example: `RUN_TRANSITIONS` in [run-state.ts](../src/shared/run-state.ts), applied by `transition()` in [queue-machine.ts](../src/server/queue-machine.ts), with [run-state-documentation.test.ts](../test/run-state-documentation.test.ts) keeping the [`runs.state`](#runsstate) table in step.

1. Add the state or edge to the machine's single owner (its transition table or owning module), and name that owner in the machine's section below.
2. Write the state only through the owner's transition function, which re-reads the row inside one `.immediate()` transaction (**tx**) or requires the prior state in its `UPDATE` (**sql**). Do not write the state column from another module. A documented lease operation, such as the `runs` claim and `deferUndispatched` in `sql/runs.ts`, is the exception; name any new one in the machine's section.
3. Update the machine's table here with the edge and its guard term from [Conventions](#conventions). For `runs.state`, the documentation test fails until the table matches `RUN_TRANSITIONS`.
4. Keep readers accepting every state a released version wrote. A trigger or `CHECK` constraint needs a migration ([database migrations](development.md#database-migrations)) and an upgrade fixture with historical rows.
5. Add a regression for the new edge, and for a stale caller being refused, at the production caller.

If a step can't be followed, say which and why in the PR instead of working around it.

## Runs

### `runs.state`

Owner: [`src/shared/run-state.ts`](../src/shared/run-state.ts) (`RUN_TRANSITIONS`).
State changes go through `transition()` in
[`queue-machine.ts`](../src/server/queue-machine.ts), which re-reads the owned
row and applies the edge, checkout hook and event in one immediate transaction
(**tx**). The two exceptions are the atomic lease claim (`queued → running`
and reclaiming running/pausing work) and guarded `deferUndispatched`
(`running → queued`); both remain lease operations in `sql/runs.ts`.

Executor boundaries are classified by [run-outcome.ts](../src/server/run-outcome.ts), whose header states how typed outcomes reach [the worker](../src/server/worker.ts) and which writes share its transaction. Native failure and interruption stay with the native supervisor.

States: `queued`, `running`, `pausing`, `paused`, `awaiting_approval`,
`interrupted`, **`completed`**, **`failed`**, **`cancelled`**.

Invariants:

- `queued` has no `worker_id` (`transition(…,"queued")` clears the lease).
- `running` and `pausing` have a `worker_id` and a recent `heartbeat`, except a
  manager run waiting for its children, which is `running` with `worker_id`
  NULL (`releaseForChildren`).
- Public run projections call unleased `running` or `pausing` work `waiting_children`; this is a display state, never a stored transition. The TypeScript rule and SQL expression live beside `RUN_TRANSITIONS`.
- `awaiting_approval` keeps the claiming worker's `worker_id`.
- `active_since` is set only while `running` or `pausing`.
- A run with a `native_dispatch` row is never claimed again.
- Ending a run (`completed`, `failed`, `cancelled`, `interrupted`) rejects its
  pending approvals and fails its unsent steering (**trigger**, migrations 025
  and 103) and records a pending checkout capture.

The following table lists exactly the edges in `RUN_TRANSITIONS`. Slash-separated
states name individual destinations. Inserts and the two lease operations above
are not transition edges.

| From | To | Trigger and guard |
| ---- | -- | ----------------- |
| queued | cancelled / paused / failed / interrupted | Cancel, Pause, invalid saved work, or startup recovery of a native dispatch receipt; tx |
| running | completed / failed / pausing / cancelled / interrupted / awaiting_approval | Completion, failure, Pause, Cancel, recovery/stop, or approval request; tx |
| pausing | paused / completed / failed / cancelled / interrupted | Runtime boundary or saved answer, work finished before the pause boundary, failure, Cancel, or recovery/stop; tx |
| paused | queued / completed / cancelled | Resume (complete when the answer is already saved), or Cancel; tx |
| awaiting_approval | queued / running / cancelled / failed / interrupted / completed | Non-native/native decision, Cancel, rejection/expiry, recovery/stop, or native turn completion; tx |
| interrupted | queued / cancelled | Explicit requeue or Dismiss; tx |
| completed | — | Terminal |
| failed | — | Terminal |
| cancelled | — | Terminal |

`queued → interrupted` retires a native run with an existing durable dispatch
receipt at startup. Its outcome is uncertain, so it cannot be left eligible for
claim or automatically replayed. Queued runs without a dispatch receipt are left
queued. `interrupted → queued` is legal but unused: Retry creates a new run with
a new idempotency key and inherits the effect authority.

Design preview seed answers start in `running` and complete through the same
transition path. A preview approval requeues via `decide`, then atomically claims
that sample before completing it. There is no `queued → completed` edge.

Public response arms are owned by [`run-contract-schema.ts`](../src/shared/run-contract-schema.ts), and the Done and Feed presentations derive from them in [`done-card.ts`](../src/shared/done-card.ts). Saved answer and lease fields do not prove a run is executing; the schema's header says why.


### `approvals.state`

States: `pending`, `approved`, `executing`, **`rejected`**, **`completed`**,
**`unknown`**. Expiry remains stored in every state; only a pending decision
uses that deadline. A pending approval's run is `awaiting_approval`.
`executing` means the external call may be in flight; `unknown` means its
outcome is uncertain and it is never replayed.
The public [approval union](../src/shared/approval-contract-schema.ts) requires
null results for pending/approved/executing records, result text for completed
and unknown records, and null or text for rejected records (design preview
rejections retain a simulation message). Request and result text stay opaque.


| From → to | Code | Guard |
| --------- | ---- | ----- |
| ∅ → pending / approved | `approvals.ts` (digest lookup first) | tx |
| pending → approved / rejected | `decide` | sql + run state in tx |
| pending → approved (automatic) | `sql/approvals.ts` auto-approve | sql: `pending` and unexpired |
| pending → rejected | run ended | trigger (migration 103), `rejectPending` |
| approved → executing | broker starts the call | sql, with the tool invocation in the same tx |
| executing → completed | broker saves the result | inside the broker's tx |
| approved → completed | native config install | `native-tools.ts`; idempotent by fingerprint |
| executing → unknown | call failed or timed out | sql |
| executing → unknown | run ended (crash) | trigger (migration 151), `sweepLeftoverToolCalls` | sql |

### `tool_invocations.state`

pending → executing (sql) → **completed**/**failed** (the same call) or
**unknown** (sql). A crash during a call leaves the invocation `executing`;
when the run reaches a terminal state the migration-151 trigger (and the
one-time `sweepLeftoverToolCalls`) marks it `unknown`.
A row in `executing` or `unknown` refuses a new request for
that call identity with 409.

### `run_steering.state`

| From → to | Code | Guard |
| --------- | ---- | ----- |
| ∅ → pending | `steering.ts` | unique idempotency key |
| pending → sending | `sql/run-steering.ts` | sql + run is `running`/`awaiting_approval` |
| sending → pending | definitely not handed over | sql |
| pending/sending → **delivered** / **failed** | delivery outcome | sql |
| pending/sending → **failed** | run ended | trigger (migration 157) |

A delivery acknowledges only when the write actually takes the row to
`delivered`; if a run-end trigger already failed it, no late `steering.delivered`
fires. The run-end trigger stores `failure_reason`: pending input becomes
`run-ended-unread`, while sending input becomes `delivery-unconfirmed`.
Mail recovery selects only the unread reason and clears it when it records a
requeue or refusal; displayed error text never authorizes another delivery.

### `scheduled_sends.state`

scheduled → **submitted**, scheduled → failed, scheduled/failed → **cancelled**,
failed → scheduled (retry). Every caller in
[`mobile-return/scheduled-sends.ts`](../src/server/mobile-return/scheduled-sends.ts)
re-reads the row in an immediate transaction (tx); submission is a savepoint,
so a refusal rolls back the partial run. The idempotency key is reused across
retries.

`later_items` use `surfaced_at` and `done_at`; every write is guarded with
`IS NULL` (sql).

### `run_checkouts.state`

∅ → started / failed (insert or ignore) → captured / failed. The capture holds
a 120 s token lease (lease); a result for a replaced token is dropped. The
capture request is recorded with the terminal run transition, so
`reconcileCheckouts` finds captures that never ran.

`run_verifications` are per-source observations, upserted only for the current
session generation; they have no lifecycle.

## Native harness sessions

### `execution_commands.state`

[`execution-commands.ts`](../src/server/execution-commands.ts): ∅ → started (tx,
primary key owner+command) → **completed** (sql + generation) or **unknown**
(sql + generation); a refused command's row is deleted. A retry of the same
command ID joins the in-flight promise or returns the stored outcome; a
`started` row left by a crash answers "unknown" and is never replayed.

### `native_dispatch.state`

∅ → unknown (written before the prompt is sent) → accepted (sql, prompt
returned) → **completed**/**failed**/**interrupted**/**stopped** on the first
terminal status event (sql: `unknown` or `accepted`). A later terminal status
from the same turn only retires the session. A run with a dispatch row is
never claimed or dispatched again. A terminal event releases the waiting turn
even if projection fails, but the run reports `interrupted` unless final output
and terminal bookkeeping were recorded successfully. Decision cleanup still runs
when output projection throws. The dispatch row still
records the harness's terminal status; it does not certify saved output.
A turn that ends before the prompt is handed over (for example a provider
change closing the session during start) is recorded as not started, not as
a "Native outcome unknown".

The same dispatch transaction records Loop-owned `runs.payload.nativeInput`:
the run ID, session generation and whether the actual adapter takes live input.
Reply routing accepts it only while that owned connection, dispatch and running
session still match. Copied or stale markers cannot authorize steering.
Session-dependent harnesses queue replies before this capability is known;
refreshing a connection does not change the capability of an in-flight turn.
Historical payloads without this optional field remain readable.
Queue request comparison and new turns exclude the observation, preserving
idempotency keys and requiring each new dispatch to record its own capability.

### `companion_sessions.state`

States: idle, disconnected, starting, failed, running, unavailable, with a
`generation`.

| From → to | Code | Guard |
| --------- | ---- | ----- |
| ∅ → idle | bind (`supervisor.ts` `session`) | tx |
| any → starting (new generation) | session start | mem: previous live closed |
| starting → idle / failed | start result | mem / sql generation |
| idle → running | turn dispatch | same tx as the dispatch row |
| running → idle / unavailable | terminal status | mem: current live |
| all → disconnected, generation NULL | worker start or close | `recover` |

Workspace preparation rechecks its captured identity after awaiting Git ([`native/workspace.ts`](../src/server/native/workspace.ts)), and startup reserves capacity under idle-eviction holds (`reserveStart` in [`native/supervisor.ts`](../src/server/native/supervisor.ts)). Turn settings commit only after the final guarded preparation step. Git diagnostics stay server-side; browser errors carry controlled setup guidance.

Disposal does not rewrite the row; readers go through the in-memory live
session or the run's state.

An adapter can decline reuse after its runtime registration changes. The next
session preparation waits for startup, rejects a still-running session and
disposes an idle one before starting a new generation. The native conversation
ID and workspace binding remain intact; refreshing a registration alone does
not dispose its live session or replay a prompt.

### `native_decisions.state`

pending → deciding (sql, after live, generation and run checks with no await)
→ pending (sql, answer not sent) / **resolved** / **expired** / **unknown**.
pending → expired when its run ends, its generation is disposed, or at
startup; deciding → unknown at startup. The generation is re-checked just
before the answer is sent. A re-emitted request id that this generation has
already resolved is ignored and does not move the run to `awaiting_approval`.

### `agent_checkpoints.stage`

[`answer-record.ts`](../src/server/answer-record.ts) owns answer record creation and its ordered writes; its header states the version predicates and recovery rules.

| From → to | Trigger | Writer |
| --------- | ------- | ------ |
| absent → model | Open managed/native answer; schema default | `openAnswer` |
| model → tools | Provider returns tool calls; save round, history and pending list | managed runtime |
| tools → tools | Complete one pending invocation; save history/pending | managed runtime |
| tools → model | All pending tools finished; clear pending list | managed runtime |
| model → done | Persist final body, then result and round/history | `finishManagedAnswer` |
| model/native → native | Partial projection, after native churn check | `writeNativeAnswer` |
| model/native → done | Final non-commentary reply, after native churn check | `writeNativeAnswer` |
| absent/previous → done | Simulator completes a response | `createPreviewAnswer` |

Queued-run editing checks checkpoint existence regardless of stage, and manual MCP results are artifact references outside this answer-text lifecycle.

### In-memory `Live` session

`NativeSessionState` in [`native/state.ts`](../src/server/native/state.ts) owns one worker process's session map and every `Live` mutation; the supervisor still orders durable writes and adapter IO.

| From → to | Trigger | Code |
| --------- | ------- | ---- |
| idle → turn (`run` set, `cancelling` false) | `execute` | `state.startTurn` |
| turn → idle | pre-dispatch preparation fails: detach only; normal turn cleanup: clear run, finish, waiting and cancelling | `state.detachTurn` / `state.endTurn`, then `state.scheduleIdle` |
| turn → cancelling | `interrupt` | `state.cancel` |
| any → closed | `dispose` (idempotent) | `state.close`, `state.disposing`, identity-guarded `state.remove` |

The `Live` invariants (turn ownership, cancellation, no reuse after close, rejected pending requests) are in that file's header.

[`native/currency.ts`](../src/server/native/currency.ts) owns the currency policies used by the supervisor, decisions, projector and tool bridge; its header states what each checks.

`native_history_actions`: ∅ → unknown (written before the fork) → completed;
an existing `unknown` row answers 409.

## Delivery and access

### `webhook_subscriptions.state`

| From → to | Code | Guard |
| --------- | ---- | ----- |
| ∅ → pending_activation | create | tx, request identity |
| pending_activation → active | accepted activation ping | sql |
| active → failed | `run.stopped` delivery exhausted | sql (not revoked) |
| failed → active | owner Retry | tx, no live lease |
| any → **revoked** | revoke (also cancels undelivered deliveries) | idempotent |

### `webhook_deliveries` (implicit)

queued → leased (tx) → sending (lease, attempts+1) → settled / delivered /
exhausted (lease). A crashed `sending` row becomes `uncertain` at the next
claim. A later attempt that fails before dispatch keeps an earlier `uncertain`
(outcome only downgrades to `unattempted`/`blocked` when it was never
dispatched), so settings still show the receiver may hold the delivery ID.
Lease expiry also has a durable workspace-notification obligation. Processing that obligation only refreshes the Settings projection; it never releases a lease, consumes an attempt, or rearms/delivers a webhook.
Delivery is at-least-once by contract with a stable
`X-Loop-Delivery` id ([integration API](cards-api.md)).

### Local creation receipts

Agent, preset-team and definition creation use [`withCreationReceipt`](../src/server/request-receipts.ts), and token writes use `withRequestReceipt` in the same file; their comments state the hashing, transaction and replay rules. Local effects commit with their receipts, so an absent local receipt implies no uncertain external effect.

Agent creation, preset-team creation and review starts keep their browser request identities in [the pending-command journal](client-state-machines.md#pending-command-identities). A refusal during recovery cannot prove whether the earlier request committed, so it keeps the identity. The agent form's recovery and separate-chat rules are in the header of [`CreateAgent.tsx`](../src/client/CreateAgent.tsx).

### `token_requests.state`

∅ → pending (tx) → complete (sql; 409 if already complete) → expired marker
(operation and hash cleared). A pending identity refuses every replay.

### Webhook request receipts

Webhook create, update, revoke, test and retry requests use the same local
receipt transaction helper. Their canonical hash binds the subscription,
operation and normalized input within the owner's request-key namespace.
Creation also checks the global subscription ID and its canonical creation
hash, so another owner cannot claim that ID. Digest formats from pre-release
builds are not recognized.

A control request commits its receipt and activation/test delivery together
before receiver IO. A replay recovers that delivery ID; delivery leases,
uncertain outcomes and explicit backlog retry stay owned by the webhook worker.
Receipt completion means the local request was recorded, not that the receiver
accepted the delivery.

### Push deliveries (implicit)

due → claimed (`available_at` = now + 60 s, attempts+1, tx) → delivered /
retry / dead (5 attempts) → pruned after 7 days. A 404/410 deletes the
subscription and its queued pushes only when the stored subscription still
holds the keys that delivery used; a browser that re-subscribed the same
endpoint in the meantime keeps its newer subscription.

### `pr_watches.state`

| From → to | Code | Guard |
| --------- | ---- | ----- |
| ∅ → watching | create | tx |
| watching → paused | hourly limit | sql |
| paused → watching | Resume (`resumeWatch`) | tx + sql |
| non-stopped → **stopped** | Stop, merged or closed | sql |

Follow-up runs use the idempotency key `pr-watch:<id>:<hash>`.

### Pairing ceremonies and devices

`pairing_ceremonies`: ∅ → pending (older pending cancelled) → **device**
/ **enrollment** on redemption (tx: pending, unexpired, origin, in-memory
liveness) or → **cancelled** (sql) on restart or origin change. A combined link
consumes both capabilities. Devices are renewed only while unexpired (sql) and
retired with a write-ahead expiry intent. `oauth_states` are selected and
deleted in one transaction.

### `agent_mail.state`

∅ → pending (tx, unique idempotency key) → held / **sent** / **refused**;
pending → pending on retry; held → sent / refused; sent → refused only for a
steering message proven unsent. Delegation results are keyed
`result:<child>:<state>`. Pending delivery, result delivery and stranded steering recovery persist
retry deadlines in `agent_mail_retries`, keyed by owner and recovery operation.
Each attempt rechecks its deadline under the write lock; successful local
delivery or recovery and removal of its retry record commit together. Failure
rolls back local work before recording either a refusal or another attempt. This mechanism never retries
an uncertain harness delivery. Retry records cascade with their source run or
mail; ineligible results retain their metadata until source deletion.

## Cloud VM experiments

### `experiment_vms.state`

Owner: `VM_TRANSITIONS` in [vm-state.ts](../src/shared/vm-state.ts), applied
only by `transitionVm()` in [vm/machine.ts](../src/server/vm/machine.ts), which
re-reads the owner's row inside one immediate transaction. A destroyed VM
leaves its project, threads, results and published files readable.

| From | To | Trigger and guard |
| ---- | -- | ----------------- |
| `provisioning` | `running` / `sleeping` / `paused` / `failed` / `destroying` | The provider reported the VM up (a reconcile can find it already asleep or paused), refused the create, or the owner destroyed it; **tx** |
| `running` | `sleeping` / `paused` / `destroying` / `failed` | Sleep observed or requested, pause, owner destroy, or a provider failure observed; **tx** |
| `sleeping` | `running` / `destroying` / `failed` | Wake for a turn or a preview, owner destroy, or a failed wake; **tx** |
| `paused` | `running` / `destroying` / `failed` | Resume, owner destroy, or a failed resume; **tx** |
| `failed` | `provisioning` / `running` / `destroying` | The owner's reconcile or retry, or owner destroy; **tx** |
| `destroying` | `destroyed` / `failed` | The provider confirmed the VM is gone (a missing VM counts), refused, or a reconcile found the destroy did not finish; **tx** |
| **`destroyed`** | — | Terminal |

### `vm_operations.state`

Owner: `VM_OPERATION_TRANSITIONS` in the same file, applied only by
`transitionVmOperation()`. The row is a receipt: it is inserted `pending`
before the provider is called, and its id is the caller's idempotency key.

| From | To | Trigger and guard |
| ---- | -- | ----------------- |
| `pending` | `succeeded` / `failed` / `uncertain` | The provider answered, refused, or gave no observed answer (timeout, disconnect, server error, or the worker's sweep found the row still pending after the longest provider call); **tx** |
| `uncertain` | `succeeded` / `failed` | A late answer arrived, or the owner's reconcile observed the outcome: a create or fork by the VM's `remote_name`, any other kind by the VM's status or published port; **tx** |
| **`succeeded`** | — | Terminal |
| **`failed`** | — | Terminal |

An uncertain operation is never sent again automatically. Whichever settles the receipt first wins; a later answer that disagrees returns the stored outcome. A reconcile writes the receipt and the VM's observed state in one transaction, as does a settled create with the VM's provider id. An observation that the effect did not happen settles nothing until the longest provider call has passed since the receipt was written, because the original call may still be in flight. A create whose VM boots into a failed state fails its receipt and keeps the VM's id, so the owner can destroy it. A retry is a new
operation with a new id, and is refused while an earlier one for the same
experiment is unsettled. Creates and forks send the provider an idempotency
key scoped to the experiment, so a retry after an "absent" reconcile reaches
the VM a still-running first attempt made instead of starting a second one.

## Fleets (experimental)

| Record | States and edges | Guards |
| ------ | ---------------- | ------ |
| `fleet_binding` | ∅ → controller/replica; controller → handoff_pending → replica; replica → controller (accept handoff); any except removed → controller (explicit recover); → **removed** | tx, signed head/parent checks; `removed` is absorbing |
| `fleet_handoffs` | prepared → committed | sql |
| `fleet_handoff_jobs` | ready → uncertain(attempt) → **complete**; ready → **superseded**; uncertain → uncertain(no attempt) at startup | sql + attempt; completion needs a verified signed directory |
| `fleet_command_receipts` | ∅ → started → **completed** / **unknown** / **refused**; ∅ → refused (reconcile retires an absent ID) | tx, sql |
| `fleet_forwarded_actions` | ∅ → unknown → started → **completed** / **refused** / unknown | sql (`unknown`/`started` only) |
| `fleet_enrollments` (source) | ready → preparing → prepared/uncertain → published → uncertain → **complete**/**cancelled** | sql + attempt, tx on receipts |
| `fleet_enrollments` (destination) | ∅ → prepared → **complete** / **cancelled** | tx |
| `fleet_distribution` | pending → acked / incompatible; incompatible → pending (local admin restart) | sql |
| `fleet_mail_outbox` | ∅ → pending → unknown → **accepted** / **refused** | tx, monotonic receipt revision |
| `fleet_mail_inbox` | ∅ → prepared/admitted; prepared → admitted / refused (expired) | tx |

## Client and host

Client and host machines (connection lease, browser owner generation, composer and command receipts, workspace socket, lock, status and harness upgrade) are in [client and host state machines](client-state-machines.md).

## Reachable invalid states

Found by reading every writer of each state; each fixed item has a regression
test that fails on the earlier code.

### Fixed

| ID | Machine | Defect | Regression |
| -- | ------- | ------ | ---------- |
| R1 | runs | Pause read `worker_id` before its transaction. If a worker claimed a manager run between that read and the write, the run became `paused` while the worker kept executing it; Resume then let a second worker claim it. The decision now uses the current row in one transaction. ([#350](https://github.com/j-asefa/loop/issues/350)) | `test/recovery.test.ts` "pauses a run from its current lease" |
| R2 | runs | A pause landing after the runtime's last boundary made `pausing → completed` illegal; the finished run stayed `pausing` and stale-lease recovery reported it `interrupted`. Completion is now lease-checked and pauses a saved answer or completes unsaved finished work. ([#350](https://github.com/j-asefa/loop/issues/350)) | `test/recovery.test.ts` "completes only under the worker's lease" |
| R3 | runs, approvals | A pause during an MCP connect failed the run with "Run is no longer executing" and marked the approved, unsent call `unknown`. A `pausing` run now finishes the call and pauses at its next boundary. ([#350](https://github.com/j-asefa/loop/issues/350)) | `test/mcp-errors.test.ts` "finishes an approved tool call when a pause arrives" |
| N1 | Live session | A throw between attaching a turn and dispatch (for example `SQLITE_BUSY` on the dispatch record) left `live.run` set: every later turn answered "already running" and settings and provider changes were refused until restart. ([#351](https://github.com/j-asefa/loop/issues/351)) | `test/native-session-permission.test.ts` "releases the session when a turn fails before it is dispatched" |
| N2 | Live session | `cancelling` stayed true after an interrupted turn, so setting changes were refused until the next turn. ([#351](https://github.com/j-asefa/loop/issues/351)) | same file, "accepts setting changes once an interrupted turn has ended" |
| N3 | native_dispatch | A second terminal status (the harness failing as the turn wound down) overwrote `completed` with `failed`, set an error on a completed run and made fleet mail refuse the run's outgoing mail. ([#351](https://github.com/j-asefa/loop/issues/351)) | same file, "keeps the first terminal status of a native turn" |
| H1 | workspace lock | A recoverer killed during recovery left `host.lock.recovery`; every later `loop start` failed with "Another process is recovering" until the file was deleted by hand. Takeover now goes through exclusive claims named for the dead record's nonce (see [workspace lock](client-state-machines.md#workspace-lock)). ([#352](https://github.com/j-asefa/loop/issues/352)) | `test/lifecycle.node.test.ts` "a dead claimant's claim is taken over through its own claim" |
| H2 | workspace lock | A stale lock whose PID was reused by another user's process returned EPERM and was treated as a live owner without checking its identity. ([#352](https://github.com/j-asefa/loop/issues/352)) | same file, "PID now belongs to another user's process" |
| W1 | pr_watches | Resume read `paused` and then wrote `watching` unguarded; a stop committed by the worker in between (pull request merged) was revived and polled again. ([#353](https://github.com/j-asefa/loop/issues/353)) | `test/sql-pr-watches.test.ts` "resumes only a paused watch" |
| C1 | send receipt, retry, upgrade | Pending composer receipts lived in `sessionStorage`, which a killed home-screen app, a new tab or auth expiry (`sessionStorage.clear()`) discarded; the restored draft then sent with a new key and could run an accepted request twice. "Retry as a new run" kept its key only in a `useRef` map, and each harness-upgrade click minted a new command ID. They now live in owner/source/thread-scoped durable storage (the local workspace's source ID is the empty string), one composer receipt per distinct message so another send or tab cannot replace an uncertain one, and are removed on settlement; another owner reads different keys. ([#354](https://github.com/j-asefa/loop/issues/354)) | `test/client-pending-identities.test.ts` |
| S1 | approvals, tool_invocations | A crash during an MCP call left the approval and invocation `executing` forever; no sweep marked them `unknown`. A run reaching a terminal state now moves its `executing` approvals and tool invocations to `unknown` via a run-end trigger (migration 151), with a one-time `sweepLeftoverToolCalls` at worker startup for any leftover, so the stored state reflects the uncertain outcome. ([#355](https://github.com/j-asefa/loop/issues/355)) | `test/recover-stuck.test.ts` S1 sweep and the tick-driven crash-recovery case |
| S2 | runs | An expired approval left its run `awaiting_approval`, holding the agent's queue, while the Feed hid the approval. `recoverStuckRuns` now fails a non-native run whose pending approvals all expired, releasing the queue and never running the call. ([#355](https://github.com/j-asefa/loop/issues/355)) | `test/recover-stuck.test.ts` "fails a non-native run whose approvals all expired" |
| S3 | runs | A graceful worker stop interrupted non-native runs that were only `awaiting_approval` and rejected their approvals; a crash left the same runs approvable. `quiesce` now interrupts only running/pausing and native awaiting_approval runs, so non-native awaiting_approval runs survive shutdown just as they survive a crash. ([#355](https://github.com/j-asefa/loop/issues/355)) | `test/recover-stuck.test.ts` "a graceful shutdown does not interrupt non-native awaiting_approval runs" |
| M1 | run_steering | When the run ended while a delivery was in flight, the run-end trigger stored the row `failed` but `steering.ts` still emitted a late `steering.delivered`. A delivery now acknowledges `delivered` only when the write actually took the row there, so a run-ended row never fires a false `delivered`. | covered by steering/native suite and review |
| M2 | webhook_deliveries | A later attempt that failed before dispatch wrote `unattempted`/`blocked`, replacing an earlier `uncertain` and hiding from settings that the receiver may already hold the delivery ID. The outcome now keeps the earlier `uncertain` unless it was never dispatched. | `test/minor-state-defects.test.ts` "a later pre-dispatch failure keeps an earlier uncertain webhook outcome" |
| M3 | push_subscriptions | A stale 404/410 deleted the subscription by id even when the browser had re-subscribed the same endpoint (upsert keeps the id), losing the new keys and queued pushes. It is now removed only when the stored subscription still matches the delivery's keys. | `test/minor-state-defects.test.ts` "a stale 404/410 does not delete a push subscription that was re-subscribed" |
| M4 | native_dispatch | A provider change racing a session start closed the live and recorded a never-sent prompt as "Native outcome unknown". A turn that ends before the prompt is handed over is now recorded as not started, not as an uncertain outcome. | covered by native session suite and review |
| M5 | native_decisions | A harness re-emitting an already-resolved request id in the same generation moved the run back to `awaiting_approval` with no decision to answer. The re-emitted id is now ignored before display bounds are checked unless its recorded decision is still `pending`. | covered by native decision suite and review |

### Open

| ID | Machine | Defect | Issue |
| -- | ------- | ------ | ----- |
| F1 | fleet_binding | A handoff whose proposal never reached the destination keeps the controller `handoff_pending`: a `missing` receipt is not final, so only an explicit recover (a new lineage) clears it. A committed source enrollment whose destination is gone cannot be cancelled. | [#356](https://github.com/j-asefa/loop/issues/356) |
| F2 | fleet_binding | `removed` is absorbing: the machine cannot create, recover or enroll without deleting its data directory. | [#356](https://github.com/j-asefa/loop/issues/356) |

