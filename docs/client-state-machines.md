# Client and host state machines

Client and host records and in-memory objects, in the format of [state machines](state-machines.md): guard terms (**tx**, **sql**, **lease**, **mem**, **trigger**) are defined in its [conventions](state-machines.md#conventions), and [reachable invalid states](state-machines.md#reachable-invalid-states) covers both pages.

## Connection backend lease

Owner: [`ConnectionLeases`](../src/connection-leases.ts). The connection
service supplies the clock, backend probe and socket validation, and wires the
registry to the relay. It owns the expiry timer, control socket, lock and tunnel.

States: `none`, `pending`, `backend`, `lapsed`. The public hello reports
`pending` as pending, `backend` as ready, and both `none` and `lapsed` as none.

Invariants:

- One service instance owns a monotonic generation counter and at most one
  populated slot. A new lease replaces earlier authority and stops forwarding.
- A pending or lapsed launch must prove its generation-bound secret before
  forwarding starts. Ownership is checked again after the asynchronous probe.
- Only the latest lapsed launch may recover. Explicit withdrawal or a newer
  lease revokes that right; pending and lapsed leases do not expire themselves.
- Heartbeats renew only an attached backend. Relay failures from an older
  generation cannot detach its replacement.
- State changes and relay publication are synchronous within the operation;
  a completed older probe cannot publish after a newer decision.
- The hello projection exposes no lease secret. Its `since` changes only on
  backend attachment or detachment, not pending/lapsed withdrawal.

| From | To | Trigger and guard |
| ---- | -- | ----------------- |
| any | pending | `lease`: confirmed tunnel address required; detach backend nonrecoverably, clear lapsed, increment generation and issue secret; mem |
| pending / lapsed | backend | `register`: generation and secret match, allowed socket, valid HMAC probe and ownership re-check after await; lease + mem |
| backend | backend | `heartbeat`: matching generation and secret renew `seen`; lease |
| pending / lapsed | unchanged | Matching `heartbeat` reports unregistered; lease |
| backend | lapsed | `expire`: clock minus `seen` strictly exceeds timeout, or `unreachable`: relay failure matches current generation; mem |
| backend | none | `withdraw`: matching generation and secret; detach nonrecoverably; lease |
| pending / lapsed | none | `withdraw`: matching generation and secret clears that slot; lease |

Stale register, heartbeat and withdrawal requests return 409 without mutation.
An invalid socket returns 400; a failed or superseded probe returns 409 without
attaching. The relay continues to return unavailable responses while detached;
no request is queued or replayed by the registry.

## Browser owner generation

[`ownerSession.ts`](../src/client/ownerSession.ts) owns the current owner and
generation together with the paired-session projection. Session reads and expiry
publish through that store; AppController subscribes to its stable snapshot with
`useSyncExternalStore` instead of setting global ownership during render.
Session reads publish only while the snapshot that started the read remains
current. A late successful response cannot replace an expired session, another
owner, or a newer identity projection for the same owner.
Cache resets finish before subscribers observe an owner change. A suspended or
abandoned render does not publish a session. Re-selecting the same owner leaves
the generation and caches alone;
signing out or selecting another owner advances it before clearing registered
module caches. View snapshots, read cooldowns, unread versions, failed-read
interests, poll capacity and detail selections register their reset at module
load. Late responses and releases still check or retain their originating
generation/state; clearing a cache does not authorize an old callback.

Drafts use this same owner for their default storage scope. Owner changes do not
delete persisted drafts or command identities. Per-view readers keep their own
lifetime and disposal rather than registering permanently with the module cache
registry.

## Composer send receipt

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

## Continuation requests

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

## Native history fork receipts

[`NativeHistory.tsx`](../src/client/NativeHistory.tsx) stores a pending fork's
command ID in an owner/source/history-entry-scoped session slot through the
shared command adapter. An uncertain response retains the ID across reloads;
retrying the same slot reuses it. Success removes only that slot before opening
the returned conversation, leaving other owners' and sources' pending forks
intact. The receipt stores an ID, not harness-owned session context.

## Native answer receipts

[`NativeControls.tsx`](../src/client/NativeControls.tsx) uses the shared command
storage adapter for owner/source/decision-scoped session receipts. Only the
command ID and answer digest are persisted, never the answer. The owner and view
generation are checked after hashing, before writing the receipt and dispatching.
The same digest reuses its command ID; an uncertain response retains it. A
confirmed execution refusal removes it only while the captured owner and
generation remain current. Successful answers retain the receipt.

## Pending command identities

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

## Workspace event socket

[`workspace-events.ts`](../src/client/workspace-events.ts): connecting → ready
→ retry with backoff → stopped (close code 4003). Polling runs while not
ready. Frames from a replaced socket or an earlier owner generation are
ignored, and replays below the cursor are refused.

## Workspace lock

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

## Workspace status and stop

[Process records](../src/process-records.ts) distinguish an absent control record
from an unreadable or malformed control/ownership record. A stale lock alone
belongs to startup lock recovery. With valid records, [inspection](../src/host-control.ts)
reports a responding host or the recorded process's running, exited or unknown
identity state; a failed request rechecks the record before reporting that state.
CLI status maps these to unresponsive, crashed and unknown. Invalid records fail
explicitly and remain available for inspection; start, restart and stop do not
silently treat them as an absent workspace. Stop returns stopped or absent to its
callers, and unresolved child records still require forced-stop recovery.

## Harness upgrade

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
