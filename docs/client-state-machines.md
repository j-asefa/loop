# Client and host state machines

Client and host records and in-memory objects, in the format of [state machines](state-machines.md): guard terms (**tx**, **sql**, **lease**, **mem**, **trigger**) are defined in its [conventions](state-machines.md#conventions), and [reachable invalid states](state-machines.md#reachable-invalid-states) covers both pages.

## Connection backend lease

Owner: [`ConnectionLeases`](../src/connection-leases.ts). The connection
service supplies the clock, backend probe and socket validation, and wires the
registry to the relay. It owns the expiry timer, control socket, lock and tunnel.

States: `none`, `pending`, `backend`, `lapsed`. The public hello reports
`pending` as pending, `backend` as ready, and both `none` and `lapsed` as none.

Its invariants (generation, secret proof, recovery, heartbeats, the hello projection, 409 on stale requests) are in the [`ConnectionLeases`](../src/connection-leases.ts) header comment.

| From | To | Trigger and guard |
| ---- | -- | ----------------- |
| any | pending | `lease`: confirmed tunnel address required; detach backend nonrecoverably, clear lapsed, increment generation and issue secret; mem |
| pending / lapsed | backend | `register`: generation and secret match, allowed socket, valid HMAC probe and ownership re-check after await; lease + mem |
| backend | backend | `heartbeat`: matching generation and secret renew `seen`; lease |
| pending / lapsed | unchanged | Matching `heartbeat` reports unregistered; lease |
| backend | lapsed | `expire`: clock minus `seen` strictly exceeds timeout, or `unreachable`: relay failure matches current generation; mem |
| backend | none | `withdraw`: matching generation and secret; detach nonrecoverably; lease |
| pending / lapsed | none | `withdraw`: matching generation and secret clears that slot; lease |

## Browser owner generation

Owner: [`ownerSession.ts`](../src/client/ownerSession.ts), whose header states its rules: generation-bound session reads, cache resets before owner changes, and drafts and command identities surviving them.

## Composer send receipt

Owner: [`sendIntent.ts`](../src/client/sendIntent.ts) with the owner/source/thread-scoped [`sendReceiptStore.ts`](../src/client/sendReceiptStore.ts). Empty → pending (new key) → cleared on 2xx, refused (key kept) below 500, unchanged on 5xx or no response; the files' comments state the resend, locking and eviction rules. Fleet sends also use the IndexedDB journal in [`fleetCommand.ts`](../src/client/fleetCommand.ts). A Feed card's inline reply ([`inlineSend.ts`](../src/client/inlineSend.ts)) records its receipt in the same slot under the composer's `sendSignature`, so a retry from the card or the thread's composer repeats the first request's key; its echo is display only.

## Continuation requests

Owner: [`continuationCommands.ts`](../src/client/continuationCommands.ts). An ordinary refusal during recovery cannot settle an earlier uncertain request.

## Native history fork receipts

Owner: [`NativeHistory.tsx`](../src/client/NativeHistory.tsx). The receipt stores a command ID, never harness-owned session context.

## Native answer receipts

Owner: [`NativeControls.tsx`](../src/client/NativeControls.tsx). Only the command ID and answer digest are persisted, never the answer.

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

[`workspace-events.ts`](../src/client/workspace-events.ts): connecting → ready → retry with backoff → stopped (close code 4003). Polling runs while not ready.

## Workspace lock

[`process-records.ts`](../src/process-records.ts): absent → held (`link`). A held lock whose owner is proven dead is replaced only through the claim named for its nonce, with one atomic rename, so the lock is never absent; the `workspaceLock` comments state the claim and recovery rules.

## Workspace status and stop

[Process records](../src/process-records.ts) distinguish an absent control record from an invalid one, and [inspection](../src/host-control.ts) reports a responding host or the recorded process's running, exited or unknown state. CLI status maps these to unresponsive, crashed and unknown. Stop returns stopped or absent, and unresolved child records still require forced-stop recovery.

## Harness upgrade

These states describe records the current build writes. Stored shapes that
released versions wrote must stay readable ([AGENTS.md](../AGENTS.md)); shapes
from pre-release builds are not migrated. Recovery preserves uncertain
operations that the current build can create.

[`harness-upgrades.ts`](../src/harness-upgrades.ts): running → complete /
restart-required / failed / unconfirmed; unconfirmed after a host restart;
restart-required → complete / unconfirmed on reconcile; unconfirmed → failed /
restart-required by owner confirmation; finished → dismissed. One upgrade runs
at a time; starts are deduplicated by command ID. The client reuses a pending
command ID in the [pending-command journal](#pending-command-identities) until
its start is acknowledged or a matching terminal status is observed. A lost
start reply retains that owner/source/runtime identity, so an explicit retry
reaches the host's command-ID dedupe rather than rerunning the installer.
