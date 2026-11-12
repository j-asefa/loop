# State machines

This is the canonical list of Loop's stateful records and in-memory session
objects: their states, the invariants each state carries, and every
transition with the code that performs it and the guard that makes it safe.
The last section lists invalid states or transitions the code could reach,
with their status. Update the relevant table in the same change that adds a
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

## Runs

### `runs.state`

Owner: [`src/shared/run-state.ts`](../src/shared/run-state.ts) (`RUN_TRANSITIONS`).
Every edge below goes through `transition()` in
[`queue.ts`](../src/server/queue.ts), which re-reads the state and applies the
edge in one immediate transaction (**tx**). Lease operations are separate.

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

| From → to | Trigger | Code | Guard |
| --------- | ------- | ---- | ----- |
| ∅ → queued | `submit` / `enqueue` | `agent-runtime.ts`, `queue.ts` | idempotency key, tx |
| queued → running/pausing | worker claim | `queue.ts` `claim` → `sql/runs.ts` `claimLease` | candidate select and update in one tx |
| running (no worker) → running | claim after children finish | same | same |
| running → queued | adapter not ready before dispatch | `deferUndispatched` | sql + lease, no dispatch row |
| running → completed | worker finishes | `worker.ts` → `completeLeased` | tx + lease |
| pausing → paused | worker finishes with a saved answer | `completeLeased` | tx + lease |
| pausing → completed | worker finishes without a saved answer | `completeLeased` | tx + lease |
| running/pausing/awaiting_approval → failed | worker error | `worker.ts` (`leaseError`) | tx + lease |
| running/pausing → interrupted | heartbeat older than 60 s | `recoverStale` | tx |
| running/pausing → interrupted, and native awaiting_approval → interrupted | graceful worker stop | `worker.ts` `quiesce` | tx |
| awaiting_approval → failed | all pending approvals expired | `recover-stuck.ts` `recoverStuckRuns` | tx |
| running/pausing/awaiting_approval/queued → interrupted | native recovery at startup | `native/supervisor.ts` `recover` | tx |
| running → awaiting_approval | tool approval needed | `mcp/broker.ts`, `native-tools.ts`, `native/decisions.ts` | tx |
| awaiting_approval → queued / failed | owner decides (non-native) | `approvals.ts` `decide` | tx re-checks approval and run |
| awaiting_approval → running | native decision resolved | `native/projector.ts`, `approvals.ts` | tx |
| queued → paused; running → pausing | Pause | `run-attention.ts` `controlRun` | tx on the current row |
| pausing → paused | Pause of a run with no worker | `controlRun` | same tx |
| pausing → paused | runtime boundary | `agent-runtime.ts`, `mcp/routes.ts`, `imports.ts` | tx |
| paused → queued / completed | Resume (completed when the answer is saved) | `controlRun` | tx |
| any non-terminal → cancelled | Cancel, Dismiss, parent cancel cascade, draft move, import cancel | `run-attention.ts`, `mobile-return/queued-runs.ts`, `workspace-routes.ts`, `queue.ts` | tx |
| queued → failed | invalid saved work | `queue.ts` `rejectInvalidRun` | sql: no worker |

`interrupted → queued` is legal but unused: Retry creates a new run with a new
idempotency key and inherits the effect authority.

Public response arms are owned by
[`run-contract-schema.ts`](../src/shared/run-contract-schema.ts). The Done-card
and Feed presentations derive their state and common identity fields from those
arms in [`done-card.ts`](../src/shared/done-card.ts). Queue rank survives claim;
the unfiltered run list also projects queue position and previews for terminal
runs. A paused run can retain its lease and saved answer, and running or pausing
work can save an answer before its completion transition. These fields are not
proof that a run is currently executing. Native error events persist errors
independently of run state, and a later completion does not clear them; every
public arm preserves that stored error field.


### `approvals.state`

States: `pending`, `approved`, `executing`, **`rejected`**, **`completed`**,
**`unknown`**. `pending` has an `expires_at`; its run is `awaiting_approval`.
`executing` means the external call may be in flight; `unknown` means its
outcome is uncertain and it is never replayed.

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

Workspace preparation and validation await Git without holding a database
transaction. Before changing a binding, the caller rechecks the live session,
binding identity and run state captured before that await. Session preparation
and settings requests share a counted idle-eviction hold. Eviction stays suspended
until every overlapping operation finishes. Capacity eviction also skips held
sessions. Startup waits for and reserves capacity before capturing its checkout
baseline or creating an adapter. Waiting retains the worker lease, checks session
identity and run state every 250 ms, and does not repeat Git validation or requeue
the run. Reservations count toward capacity until the live session is installed,
and failures release them. Existing permission overrides and model settings are
updated only after the final guarded preparation step, so cancellation during
capacity waiting or checkout capture does not commit those turn settings.
Completion or failure re-arms
eviction only for an idle, open live session. Same-process callers
preparing the same checkout share one pending preparation. Fetch and immutable
base-commit resolution are serialized per common Git directory within the
process; Git locks arbitrate between processes. Git diagnostics stay in server-side error causes, while
browser-facing errors contain controlled setup guidance.

Disposal does not rewrite the row; readers go through the in-memory live
session or the run's state.

### `native_decisions.state`

pending → deciding (sql, after live, generation and run checks with no await)
→ pending (sql, answer not sent) / **resolved** / **expired** / **unknown**.
pending → expired when its run ends, its generation is disposed, or at
startup; deciding → unknown at startup. The generation is re-checked just
before the answer is sent. A re-emitted request id that this generation has
already resolved is ignored and does not move the run to `awaiting_approval`.

### In-memory `Live` session

[`native/state.ts`](../src/server/native/state.ts), owned by one worker
process. Fields: `run` (the attached turn), `cancelling`, `waiting`,
`closed`/`disposal`, `requests`, `finish`, `idle` timer.

| From → to | Trigger | Code |
| --------- | ------- | ---- |
| idle → turn (`run` set, `cancelling` false) | `execute` | `supervisor.ts` |
| turn → idle (`run`, `finish`, `waiting`, `cancelling` cleared; idle timer armed) | turn ends, including failures before dispatch | `execute` `catch`/`finally` |
| turn → cancelling | `interrupt` | `supervisor.ts` |
| any → closed | `dispose` (idempotent) | `supervisor.ts` |

Invariants: `run` is set only while `execute` owns the turn; `cancelling` is
true only while that turn is being interrupted; a closed live is never reused.
Pending protocol requests are rejected on exit or disposal.

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
Delivery is at-least-once by contract with a stable
`X-Loop-Delivery` id ([integration API](cards-api.md)).

### Local creation receipts

Agent, preset-team and definition creation use
[`withCreationReceipt`](../src/server/request-receipts.ts). An immediate
transaction reserves the owner/key against concurrent local creators, checks
its canonical request hash, and commits the creation and receipt together.
A matching receipt recovers the existing result; different input returns 409.
A failed local creation rolls back both effect and receipt, so no uncertain
external effect is implied by an absent local receipt. Recovery still applies
the domain's owner checks and deleted-result rules.

Request hashing sorts object keys and preserves array order. Token writes use
the same encoder. Both use `withRequestReceipt` for transaction boundaries:
local effects commit with their receipts, while external token writes commit
a pending reservation before IO and complete in a second transaction. Refused
replays never execute the effect; expiry markers commit before a refusal is
returned.

Agent creation, preset-team creation and review starts keep their browser
request identities in
[the pending-command journal](#pending-command-identities), keyed by owner,
source, operation and form inputs. Reloading can recover an uncertain creation.
A fresh 4xx can settle a refused request; a refusal during recovery cannot prove
whether the earlier request committed and therefore retains its identity.
Storage failure prevents dispatch. Completion callbacks require the same
mounted owner/source view. Agent creation hashes its form inputs rather than
storing prompt or instruction text. When the name is generated, that name is
stored with the pending identity and reused on recovery; a new suggestion
cannot select another identity. Other inputs must still match. A digest avoids
plaintext retention but does not encrypt low-entropy input. After an uncertain
agent creation, the form offers an explicit separate-chat action. It archives
the uncertain identity before releasing its slot, then requests a new name;
it does not dispatch another creation. Matching generated-name forms in two tabs
share the pending operation rather than create two agents: neither the tab nor
a new suggestion proves that the earlier uncertain creation should be repeated.
Recovery updates the displayed name to the stored name. To request a distinct
creation after uncertainty, use the explicit separate-chat action. Archive
failures preserve the action
for retry. The person must check for the earlier chat and submit again.

### `token_requests.state`

∅ → pending (tx) → complete (sql; 409 if already complete) → expired marker
(operation and hash cleared). A pending identity refuses every replay.

### Webhook request receipts

Webhook create, update, revoke, test and retry requests use the same local
receipt transaction helper. Their canonical hash binds the subscription,
operation and normalized input within the owner's request-key namespace.
Creation also checks the global subscription ID and its canonical creation
hash, so another owner cannot claim that ID. Earlier-build digest formats are
outside the fresh-install policy.

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

### Composer send receipt

[`sendIntent.ts`](../src/client/sendIntent.ts): `{signature, key, intent,
pending, unquoted}` per message (keyed by its signature; settled entries are pruned toward 20 per thread, uncertain entries are never evicted), stored in an owner/source/thread-scoped durable store
([`sendReceiptStore.ts`](../src/client/sendReceiptStore.ts), using the shared
[`pendingCommandStorage.ts`](../src/client/pendingCommandStorage.ts) JSON adapter
and Web Locks helper, backed by `localStorage`), so a pending send survives a killed home-screen app, a new
tab and auth expiry (Session clears `sessionStorage`, never these receipts).
Empty → pending (new key) → cleared on 2xx, refused (key kept) on a Loop
response below 500, unchanged on 5xx or no response. A pending receipt for
the same message, found in the store even if another tab or an earlier session
sent it, is resent with the same key, intent and explicit `unquoted` reply-target decision; settlement compares the key and attempt generation before touching the
entry with the sent key. A Web Lock covers reading, selecting and storing the
identity and each settlement, so concurrent tabs cannot overwrite one another's
journal changes. Persistence failure refuses a new send before dispatch;
settlement failure retains the pending identity. The composer checks its current
view and starts dispatch synchronously in the preparation lock callback, then
releases the lock before awaiting network IO or settlement. Earlier builds' receipt formats
are outside the fresh-install support policy in [AGENTS.md](../AGENTS.md).
Fleet sends also use
the IndexedDB command journal in
[`fleetCommand.ts`](../src/client/fleetCommand.ts) (reserved → dispatched →
removed on a terminal answer), which turns a repeat into a receipt-only query.

### Continuation requests

[`continuationCommands.ts`](../src/client/continuationCommands.ts) stores the
exact continuation request in owner/source/thread-scoped local storage through
the shared command adapter. Each request has its own idempotency-key slot;
preparing another continuation does not evict an uncertain one. A per-tab
session marker selects a saved request or explicitly selects new work. That
marker is optional; saving the durable request must succeed before dispatch.
Reloads validate saved requests against the current route schema. Acceptance
removes only the matching request, and cleanup failure retains its identity
without turning acceptance into a reported failure. The conversation UI retains
its outcome policy: an ordinary refusal during recovery cannot settle an earlier
uncertain request.

### Pending command identities

[`pendingCommands.ts`](../src/client/pendingCommands.ts) stores a pending
command ID and attempt ID in owner/source/operation-scoped `localStorage`.
The owner/source/operation slot is shared through
[`pendingCommandStorage.ts`](../src/client/pendingCommandStorage.ts), whose
persistent adapter propagates storage failures. Integration-token creation uses
the same scoped slots with an in-memory adapter: its request ID, name, scopes
and secret survive closing Settings, but never go to local/session storage or
the URL. A lost creation response is reconciled against the token list; a retry
reuses the exact request. Closing the page loses that ephemeral secret.

Durable command preparation holds a Web Lock, records both identities before dispatch, and
refuses dispatch if storage or the current view is unavailable. Concurrent
attempts of the same logical request reuse the command ID; only the latest
attempt may remove its receipt. A terminal upgrade status read can also settle
the matching command ID, regardless of the recovery attempt, but cannot remove
a different command in that owner/source/runtime slot. A lost reply or an explicit unknown execution
outcome retains it across reloads. An authoritative success, refusal or
completed outcome settles it. An ordinary artifact-route 4xx settles a fresh
request, but cannot settle an earlier uncertain attempt. A later authentication
refusal therefore cannot cause a previously accepted refresh to be sent with a
new ID.

Runtime enable/refresh uses this journal with its command inputs—runtime,
project and billing—as its target. Discovery versions and sign-in status do not
change an uncertain command’s identity. Reloading retains an
uncertain verification identity. The existing status-inspection action does not
dispatch; an explicit "Start new verification" archives the matching uncertain
attempt before preparing a new command. A storage failure during that archive
retains the recovery handle so the explicit action can be retried. A refusal
while recovering keeps the uncertain ID, because access checks may refuse
before consulting the authority's receipt. Late replies cannot update an unmounted
or replaced owner/source view.

An unknown server receipt can remain unknown permanently. The recovery UI
warns that status inspection cannot prove the outcome and requires explicit
acknowledgement that a new command may repeat the change. Confirmation takes
the same lock, verifies the view and exact pending attempt, archives its identity
in owner/source-scoped history, then releases the active slot. It does not mark
the old receipt as settled or dispatch anything. A later explicit action gets a
new identity. Failed storage writes, stale views and newer attempts prevent
superseding the pending identity.

Provider-key identity includes a SHA-256 equality fingerprint of the normalized
key, so entering a different key is a separate explicit request. Credential
values are not stored in this journal. A fingerprint establishes equality; it
does not encrypt a low-entropy value. Existing native command receipts remain
the authority for whether an external effect ran.

### Workspace event socket

[`workspace-events.ts`](../src/client/workspace-events.ts): connecting → ready
→ retry with backoff → stopped (close code 4003). Polling runs while not
ready. Frames from a replaced socket or an earlier owner generation are
ignored, and replays below the cursor are refused.

### Workspace lock

[`process-records.ts`](../src/process-records.ts): absent → held (`link`). A held lock whose
owner is proven dead (no such process, a zombie, or a different process
identity, including a PID now owned by another user) is replaced only by the
starter that links the claim named for that record's nonce
(`host.lock.stale.<nonce>`). Holding the claim, it re-reads the lock and
replaces it with one atomic rename, so the lock is never absent. A dead
claimant's claim is taken over the same way, through its own claim. All
claims use the root lock prefix and recovery traverses them iteratively, so
repeated crashes impose no depth or growing-path limit. Thus no
file is ever removed after a separate check and two starters cannot both
succeed. Nonces must be UUIDs before they are used in a path. Once the lock is
held, claims for records it no longer holds and dead starters' temp and
rename files are removed. Release removes the lock only when the nonce still
matches. A live owner at the root lock produces `LockBusyError`; connection
startup carries its code over IPC and the launcher returns to service discovery.
Recovery-claim conflicts remain errors, so they are not mistaken for an
available service.

### Workspace status and stop

[Process records](../src/process-records.ts) distinguish an absent control record
from an unreadable or malformed control/ownership record. A stale lock alone
belongs to startup lock recovery. With valid records, [inspection](../src/host-control.ts)
reports a responding host or the recorded process's running, exited or unknown
identity state; a failed request rechecks the record before reporting that state.
CLI status maps these to unresponsive, crashed and unknown. Invalid records fail
explicitly and remain available for inspection; start, restart and stop do not
silently treat them as an absent workspace. Stop returns stopped or absent to its
callers, and unresolved child records still require forced-stop recovery.

### Harness upgrade

These states describe records written by the current build. Earlier Loop
builds and their stored state shapes are outside the [fresh-install support
policy](../AGENTS.md). Recovery preserves uncertain operations that the current
build can create; it does not migrate earlier state formats.

[`harness-upgrades.ts`](../src/harness-upgrades.ts): running → complete /
restart-required / failed / unconfirmed; unconfirmed after a host restart;
restart-required → complete / unconfirmed on reconcile; unconfirmed → failed /
restart-required by owner confirmation; finished → dismissed. One upgrade runs
at a time; starts are deduplicated by command ID. The client reuses a pending
command ID in the [pending-command journal](#pending-command-identities) until
its start is acknowledged or a matching terminal status is observed. A lost
start reply retains that owner/source/runtime identity, so an explicit retry
reaches the host's command-ID dedupe rather than rerunning the installer.

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
| H1 | workspace lock | A recoverer killed during recovery left `host.lock.recovery`; every later `loop start` failed with "Another process is recovering" until the file was deleted by hand. Takeover now goes through exclusive claims named for the dead record's nonce (see Workspace lock). ([#352](https://github.com/j-asefa/loop/issues/352)) | `test/lifecycle.node.test.ts` "a dead claimant's claim is taken over through its own claim" |
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

