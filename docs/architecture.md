# Architecture

Loop has one React UI, workspace API and SQLite migration set. The companion workspace uses device pairing and a local host-owned worker. It runs directly on the host or in the Docker companion.

## Source map

| Boundary                                                  | Production source                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI and native harness discovery                          | [cli.ts](../src/cli.ts), [local-harnesses.ts](../src/server/local-harnesses.ts)                                                                                                                                                                                                                   |
| Companion host, worker ownership and device authorization | [workspace-host.ts](../src/workspace-host.ts), [host.ts](../src/host.ts), [device pairing](../src/server/device-pairing.ts)                                                                                                                                                                       |
| Agent-source discovery and paired proxy                   | [agent-sources.ts](../src/agent-sources.ts)                                                                                                                                                                                                                                                       |
| Workspace app and worker                                  | [index.ts](../src/server/index.ts), [worker.ts](../src/server/worker.ts)                                                                                                                                                                                                                          |
| Queue and managed model/tool loop                         | [queue.ts](../src/server/queue.ts), [agent-runtime.ts](../src/server/agent-runtime.ts)                                                                                                                                                                                                            |
| Native execution                                          | [native-sessions](../src/server/native-sessions.ts), [adapters](../src/adapters), [subscriptions](../src/server/subscriptions.ts)                                                                                                                                                                 |
| Companion execution authority                             | [execution-client.ts](../src/server/execution-client.ts), [execution-authority.ts](../src/server/execution-authority.ts), [process supervisor](../src/server/execution-process.ts), [ownership lock](../src/server/execution-ownership.ts), [wire contract](../src/shared/execution-authority.ts) |
| Database and migrations                                   | [db.ts](../src/server/db.ts), [migrations](../migrations)                                                                                                                                                                                                                                         |
| Persisted row contracts                                   | [SQL rows](../src/server/sql/rows.ts), [JSON row parsers](../src/server/row-schemas.ts), [per-table query modules](../src/server/sql/)                                                                                                                                                            |
| Feed and mobile-return API facade                         | [mobile-return.ts](../src/server/mobile-return.ts), [mobile-routes.ts](../src/server/mobile-routes.ts)                                                                                                                                                                                            |
| Reading position and outlines                             | [reading-position.ts](../src/server/mobile-return/reading-position.ts), [outlines.ts](../src/server/mobile-return/outlines.ts)                                                                                                                                                                    |
| Later and scheduled sends                                 | [later.ts](../src/server/mobile-return/later.ts), [scheduled-sends.ts](../src/server/mobile-return/scheduled-sends.ts)                                                                                                                                                                            |
| Queued-message editing and conversation forks             | [queued-runs.ts](../src/server/mobile-return/queued-runs.ts), [forking.ts](../src/server/mobile-return/forking.ts)                                                                                                                                                                                |
| Feed effect authorization                                 | [effect-authority.ts](../src/server/effect-authority.ts), [sourceAvailability.ts](../src/client/sourceAvailability.ts)                                                                                                                                                                            |
| Results stream (result cards and files, `/api/results`)   | [results.ts](../src/server/results.ts), [core-routes.ts](../src/server/core-routes.ts)                                                                                                                                                                                                            |
| Your profile, sent prompts and decision history           | [user-profile.ts](../src/server/user-profile.ts), [personal-history.ts](../src/server/personal-history.ts), [personal-decisions.ts](../src/server/personal-decisions.ts)                                                                                                                          |
| UI and shared contracts                                   | [client](../src/client), [shared](../src/shared), [workspace contracts](../src/shared/workspace-api.ts), [registrar](../src/server/registrar.ts), [browser API](../src/client/workspace-api.ts)                                                                                                   |
| Client state, navigation and session lifecycle            | [app/AppController.tsx](../src/client/app/AppController.tsx), [navigation state and URL targets](../src/client/app/Navigation.ts), [app/Session.tsx](../src/client/app/Session.tsx)                                                                                                               |
| Client shell and page composition                         | [App.tsx](../src/client/App.tsx), [app/AppView.tsx](../src/client/app/AppView.tsx), [app/AppPages.tsx](../src/client/app/AppPages.tsx), [explicit view props](../src/client/app/AppViewProps.ts)                                                                                                  |
| Client workspace loading and result paging                | [app/WorkspaceData.ts](../src/client/app/WorkspaceData.ts), [app/Results.tsx](../src/client/app/Results.tsx)                                                                                                                                                                                      |
| Composer UI, draft lifecycle and sends                    | [app/Composer.tsx](../src/client/app/Composer.tsx)                                                                                                                                                                                                                                                |

The feed reaches fleet authorization only through [effect-authority.ts](../src/server/effect-authority.ts), where fleet code registers its implementation, and the browser feed and composer reach fleet capability checks only through [sourceAvailability.ts](../src/client/sourceAvailability.ts); the [boundary test](../test/source-boundaries.test.ts) enforces this for the feed paths it names.

Browser code in `src/client` and server code in `src/server` never import each other; anything both need lives in `src/shared`, which imports neither. The [boundary test](../test/source-boundaries.test.ts) enforces this. Root modules and adapters may import shared contracts but never client code. Client and shared modules never import root modules. Native sign-in drivers depend on [their contract](../src/native-auth/types.ts), not the server coordinator or execution adapters; both Muse callers use the [MSP host](../src/muse-host.ts).

Device pairing and trust are core ([device-pairing.ts](../src/server/device-pairing.ts)) and need no machine identity; fleet enrollment extends them in [fleet-pairing.ts](../src/server/fleet-pairing.ts).

A companion gateway started with `--fleet` ([fleets](pairing.md#fleets-experimental)) maintains a durable Ed25519 machine identity in
`fleet_machine_identity`. Its private key uses the existing encrypted secret
store and stays on that installation; changing a tunnel origin does not replace
it. Missing or inconsistent signing material fails startup rather than creating
a replacement identity. Preview gateways do not initialize this identity. Initializing an identity alone does not enroll peers or enable
remote access.

The fleet authority layer stores signed directory history, local owner consent,
peer scopes and controller handoff receipts in immediate transactions. Directory
edits compare the expected head; replicas cannot administer membership. Preparing
a handoff durably fences the old controller before returning its signed proposal.
The incoming controller commits its acceptance before returning proof, and a lost
reply never automatically restores the old writer. An explicit local recovery
pins a new controller and grant while retaining the previously accepted history.
It grants no recovered authority to members that have not separately consented.

Controller handoff jobs persist the proposal and writer fence together before
dispatch. Only one durable attempt sends the transition. An uncertain outcome
survives replacement instances; a nonce-bound receipt query can recover the
destination's committed acceptance without sending the proposal again. A missing
receipt never reactivates the old writer. A confirmed changed origin can route
that proof-bound read without rewriting directory addresses. Completion records
the historical outcome without replacing a later explicit recovery decision.
Destination acceptance and pending dissemination rows commit atomically.

Directory synchronization serves authenticated pages of already signed history
from any currently authorized replica. Pages contain at most 32 entries and
768 KiB of entry data; a reported remote head does not establish global freshness.
An owner-scoped index caches ancestry only from verified, immutable stored
directories. Startup primes retained history, and committed local inserts warm
new paths after their transaction completes. Missing cursors fail an indexed
existence check; known cursors use logarithmic ancestry lookup, followed by normal
signature checks for the bounded response page. Late predecessor retention
refreshes incomplete paths. Transaction-local reads do not populate the shared
cache, and recovery roots never connect to their named prior lineage.
A removed caller can prove its former machine key to retrieve only the chain
ending at its own recorded removal. Later revisions and unrelated cursors remain
inaccessible. The removal index is populated with directory acceptance and
backfilled from retained predecessor history during migration.
Receivers verify a complete successor chain from local trust before updating
grants in one transaction. Known revisions are read-only, forks and automatic
recovery resets are refused, and a known tombstone cannot be overwritten by an
older map. A removed destination stops at its own removal and acknowledges the
exact accepted prefix. These routes require completed local enrollment; they
cannot activate pending consent.

A newly admitted replica may include a bounded signed admission chain in its
history query. A paged update can carry the remaining admission chain beyond
the page being applied. The receiving replica verifies that chain from its current head
and checks the sender's final membership before returning history; the query
does not change its grants. An update installs only its page, leaving the proof's
continuation unapplied. Admission proofs allow up to 1,024 entries and
768 KiB, including the update page when sent together. A controller that pinned its own enrollment without older history can
retain verified missing predecessors by checking every edge backward from its
current trusted lineage. This fills history only; it never changes authority or
crosses a recovery reset. Admission selects the newest suffix within its byte
budget. A peer older than that suffix remains unsynchronized; retained older
history cannot block the single-entry acknowledgement of a known removal.

The companion's durable directory outbox sends to at most two peers at a time,
using bounded pages and retry backoff. A signed destination acknowledgement is
distinct from enrollment completion. It stores the exact outgoing packet before
transmission and can repeat only that digest-idempotent directory operation
after a lost reply or restart. A replacement worker fences old callbacks,
including the transaction that installs a reconciliation result;
shutdown aborts outstanding requests. Removed recipients retain delivery to
their last signed address. An unavailable peer stays pending, and incompatible
history requires explicit reconciliation rather than automatic grant restoration.
A concurrent local synchronization is retryable, not permanent incompatibility.
Before transmitting a signed roster or retransmitting a stored packet, the
worker verifies a fresh nonce-bound machine proof at the enrolled address. An
unsigned refusal alone cannot make it disclose historical rosters to a reused
origin. The CLI acquires its exclusive workspace lock before constructing the
host and worker; a losing concurrent start cannot replace the active instance.

A separate pending-directory protocol follows the signed lineage pinned by a
spent enrollment ceremony, using durable destination-signed checkpoints. It
never installs a binding or peer grants. A verified removal cancels that pending
operation before any delayed enrollment commit can activate it. Discovery names
only operation IDs already published in the sender's signed lineage; it cannot
adopt a newer local ceremony merely because its inactive grant matches. Every push and
acknowledgement binds the exact enrollment operation, even when a newer ceremony
reuses the same inactive grant and checkpoint. Checkpoint reads
require membership in the checkpoint or an anchored admission proof; relaying a valid controller-signed prefix
can advance or cancel inactive consent without making the relay an enrolled
peer. Recovery checkpoints affect only the new pending consent, preserving any
unrelated existing local grant. Removal delivery checks this consent even when
ordinary history succeeds through an older, incompatible binding. If enrollment completes between pages, delivery
switches to ordinary synchronization.

The companion's `/api/fleet/admin/` routes require its authenticated local device
session, current Origin/CSRF checks and a live device authorization before
dispatch. Cards tokens, peer proofs and previews cannot enter
that boundary. The requesting device cannot nominate another local owner.
Create/recover, enrollment, removal, self-address repair and handoff use explicit
confirmation, expected directory heads and durable operation identities. Source
enrollment rechecks the device after remote identity discovery and before
claiming dispatch. Device revocation invalidates its active administration
requests. Recovery lists former unconfirmed members separately and restores no
grant for them. The gateway-owned browser authority context reads this local API
independently of the selected conversation source, refreshes on foreground and
reconnect, and retains an unavailable roster as stale while disabling edits.
The [fleet administration flow](pairing.md#add-and-manage-machines) exposes explicit
consent, receipts and bounded operation/delivery pages. Delivery retry retains
the exact durable signed packet and refuses work from a retired recovery lineage.
An open fleet sheet refreshes delivery records after each successful authority
read. When the directory head changes, it hides earlier delivery status until
the new read completes; a late response cannot restore an old acknowledgement.
Loaded pages from the same head remain available while every loaded page is
refreshed. Loading another page waits for that refresh, so a late first-page
result cannot erase newly loaded rows.

Retained ordinary ancestors remain current regardless of lineage length;
only a recovery boundary retires that history. Directory distribution verifies
the entire retained connecting lineage. Preparing a transmission retains only
its bounded oldest prefix and potential admission continuation, rather than all
newer documents. Wire pages and admission proofs retain their separate byte and
entry limits.

The directory reconciliation primitive retrieves those pages from an enrolled
replica without an access credential. It verifies the complete connecting chain
before atomically accepting successors of the local head. A concurrent authority
change, unknown recovery root, conflicting ancestor or invalid page leaves local
grants unchanged. Reads have two concurrent slots, a 45-second overall deadline,
and a 1,024-entry/16 MiB assembly limit; unavailable history remains unsynchronized.
A shared refresh rotates among replicas within its deadline, so an unreachable
controller does not permanently prevent another replica from supplying history.
The directory outbox uses this primitive when a recipient reports a newer
unknown head. Credential refusal can also trigger this shared refresh, with one
pending refresh and a thirty-second cooldown across all operation leases.

The peer workspace catalog allowlists existing local GET contracts. A
read credential maps to the destination owner; callers cannot select another
owner/source, arbitrary URLs or private native/provider endpoints. The in-memory
bridge runs existing middleware and public projections. Signed responses bind
the request, machine, grant, directory and source clock. Catalogs advertise only
locally consented and mounted capabilities. Unknown
operation names grant no local route and preserve compatible known reads.
Destination reads have four slots and a 2 MiB limit;
clients allow four requests per peer, sixteen overall, cancellation and a
45-second deadline. The bridge holds its four read and four action slots until
handlers finish, even after HTTP timeouts; expired middleware cannot start a
handler. Commands deduplicate before admission, in-flight duplicates share their
operation, and receipts remain readable during unrelated work. Rejection
invalidates only the credential used. Verified directory changes trigger bounded
history reconciliation without replaying the read. Companion startup mounts
these services through
[FleetWorkspaceServices](../src/server/fleet-workspace-services.ts) for its local
owner. The same lifecycle mounts named actions, files, uploads and device-only
receipt reconciliation, and closes pending services before stopping the gateway.
Constructing a companion installs no peer grant and starts no workspace polling.
Isolated previews do not mount these services.

The dedicated machine event socket requires an events-scoped credential in its
authorization header and refuses browser credentials or URL parameters. It reuses
the owner-scoped workspace replay, subscribing before reading. A subscription
selects bounded conversation/run details; unopened transcripts become scoped
invalidations while summary and decision projections retain their existing
contract. Each frame signs the subscription UUID, sequence, directory and source
identity. Credential expiry, changed authority or failed heartbeat closes the
stream. Its receiving frame and outgoing buffer limits are 40 KiB and 2 MiB;
workspace frames retain their 512 KiB bound before the signature envelope.
The gateway's owner-bound multiplexer shares one demanded upstream per source
among its viewers. It verifies every peer frame's signing key, request nonce,
sequence, grant and directory head before forwarding; changes to authority close
the old stream. Each source retains its own epoch, cursor and capability metadata.
The last viewer releases that upstream. At most 24 peer event connections are
active in one gateway; additional sources use the existing bounded read fallback.

Companion pages open one authenticated browser
socket at `/api/events/multiplex/ws`. Its source-qualified envelopes feed the
existing client projections rather than another Feed store. The gateway keeps at
most 128 source entries, 1,024 logical viewers and 128 subscriptions per browser.
Each source replay ring holds at most 32 frames and 512 KiB. A gap produces a
source reset at its current watermark so HTTP snapshots reconcile the missing
facts. A browser above the 2 MiB outgoing buffer limit reconnects and reconciles.
Subscription input is bounded to 40 KiB and rate limited; opened detail unions
allow at most 16 conversations and 16 runs per source. Local and peer producers
filter unopened transcript and trace payloads using the current v3 protocol.

The page releases its socket and pauses event polling while hidden, then resumes
its independent source cursors on foreground. Fallback event reads share four
active slots and a four-per-second token bucket with a burst of eight. Queued
subscriptions coalesce by logical source subscription, with 32 initial tokens and
16 replenished per second. Preview multiplexers can access only their isolated
local workspace.

One companion shares its [capacity budget](../src/server/fleet-capacity.ts)
across workspace HTTP, browser and integration-token sockets, peer HTTP/sockets
and outbound peer transports. Direct integration clients use the existing
workspace-client budget, including its single-machine behavior. A multi-member fleet admits at most 160 managed operations, including
64 inbound peers and 32 outbound operations with four per destination. It reserves
32 slots for browsers, which may borrow spare capacity. Public HTTP requests use
a separate allowance of 16 requests with a 15-second deadline; paired devices and
integration tokens authenticate before entering the browser budget. The peer HTTP
parser retains its own 16-request limit and deadline. A fleet of one keeps
existing browser admission. Socket handlers authenticate before spending shared
connection setup tokens. Connection setup uses bounded token buckets; busy
transports preserve a bounded Retry-After cooldown per destination across callers.
Capacity hints are advisory. A 429/5xx response is not a command receipt, and no
accepted mutation is cancelled or replayed to free capacity.

The enrolled peer source adapter projects the verified catalog into source
capabilities. Browser controls never inherit another machine's permissions.
A peer deep link keeps that source selected when it is unavailable and establishes
its device session at the serving gateway. Typed mutation
helpers share the same fixed action contracts and browser command journal;
unsupported paths refuse without falling back locally. Native decision receipt
keys include the browser owner, machine and decision identity.

Destination fleet command receipts retain their original identity across retries,
gateway changes and restarts. They project responses through the owning public
contract, bound cached response bodies, and retain compacted completion records.
Every receipt carries its action tag; a mismatched tag cannot reinterpret a stored
result as another action response. Receipt reads never repeat the accepted effect.
Their payload digest binds the parsed wire input before handler defaults and
inner idempotency keys are supplied, so receipt queries use the same payload.
A process exiting after dispatch leaves an uncertain receipt; reading or retrying
it never submits the effect again. Directory/grant checks precede dispatch, and
the owning native handler still enforces decision generations. Named peer
agent-action HTTP endpoints execute those same owning handlers.

The browser commits its origin/owner command journal in IndexedDB transactions.
It retains operation identities and semantic/payload digests, with no raw prompts,
answers or credentials. These digests bind equality and receipt recovery; they do
not encrypt low-entropy values whose other request fields are known.
It reserves a per-command Web Lock before publishing an entry and holds it through
authorization and response handling; concurrent tabs and
bodyless lookups cannot overtake that first send. Acquiring a busy command lock
releases the journal lock first, allowing earlier retries to settle. A new
intent whose authorization or preparation fails before the action fetch is
released without declaring a destination refusal or rotating the caller's ID;
an existing uncertain intent remains receipt-only. Queued callers recheck the
journal under their command lock. If an earlier caller removed the entry, an
action reserves again with the same bound identity; the gateway reconciles any
previous dispatch. A stale bodyless lookup sends nothing. The gateway reserves the
command before asynchronous destination preparation. Existing receipt queries
do not require the original action to remain advertised. Gateway failures remain
uncertain: the same command may have executed through another gateway. Local
validation or lost authorization also cannot settle an older command. Destination
reconciliation returns its existing outcome or atomically retires an absent ID
with a durable refusal, preventing delayed transports from executing it. Only that
verified refusal permits a fresh intent. A lookup at the same gateway cannot
overtake its active original send; an earlier lookup from another gateway may
retire the command before it arrives. A missing or unverifiable receipt retains
uncertainty. Receipt queries bind the action name and signed request digest;
reading an outcome never retransmits the action.

Fleet work retains its creator and every peer edit, resume or explicit scheduled
retry in the owning transaction, including work created locally. Scheduled
conversion, queue moves, delegation, review fan-out and local mail
inherit all constraints. Steering, native/API approvals and permission changes
to a waiting native turn add the peer before delivery; uncertainty preserves it.
Pending mail rechecks the sender's grants; never-delivered steering retains them
when converted to a queued turn. Revocation of any contributor blocks later
dispatch. Committed events clear the waking request's ambient context so consumers
use their own stored constraints.

Native prompt, steering and answer callbacks recheck the run, generation and
grants after adapter preparation, immediately before input. Definitively refused
answers discard only their new constraint in the recovery transaction; accepted,
uncertain and earlier contributions remain. API execution checks grants before
each tool, the MCP broker checks after connection preparation, and the native
tool bridge checks before tool entry.

Currently authorized peers share the destination owner's approved operation
scope, including receipt reconciliation. Receipts retain the originating peer
for provenance; the owner, fleet, grant, operation and original command UUID
identify the same accepted work across gateways.

The [fleet mail journal](../src/server/fleet-mail-journal.ts) retains a separate
source/message identity for direct mail. An envelope binds both machines and
their grants, sender run, two-party thread, conversation and file content
references. Address revisions preserve that envelope; changing either grant
refuses its use. The outbox commits uncertainty before transmission and then
requires receipt reconciliation. Inbox admission and the owning mail queue
share one SQLite transaction; duplicates return its original admission without
invoking that queue again. Both journals bound unsettled work to 100 records per
owner, including unadmitted reservations. The inbox also limits one authenticated
peer to 50 unsettled identities, including held mail; changing claimed agents or
threads cannot create more capacity. When the inbox reaches either limit, it
refreshes accepted admissions from the owner's local mail rows and expires old
reservations before refusing new work. Completed local mail frees capacity even
if its sender is offline or its grant has been removed; this inspection does not
dispatch work or give the former sender access. Settled payloads compact while
identity tombstones remain. Unconfirmed outgoing effects retain their quota and
original identity until an authorized destination receipt resolves them; removing
a grant cannot prove that an earlier send did not execute.

The [mail transport](../src/server/fleet-peer-mail.ts) probes the destination's
enrolled key before sending a mail-scoped credential. Its fixed directory,
preparation, acceptance and receipt endpoints sign the request digest, current directory,
method and destination identity. Capacity admission precedes the durable send
claim. Preparation reserves the original source/message/digest without queueing
work or granting content access. After an ambiguous send, only a fresh signed
prepared receipt permits retransmitting that exact envelope through the same
atomic inbox boundary. The sender consumes its stored preparation before IO;
restart must query the destination again. Missing receipts leave delivery unknown,
and expired preparations become retained refusals after thirty minutes. Accepted
mail only reconciles its receipt and never repeats an external harness effect.
Preparation alone grants no file or model-context access.

The optional [mail file transport](../src/server/fleet-mail-files.ts) binds private
chunks to an unaccepted message reservation and the current mail and files
grants. Each file is at most 25 MiB and each chunk at most 192 KiB. Staging reserves
at most 200 MiB per authenticated sending machine, across owner/grant aliases,
and 256 MiB across the receiving machine. One peer can stage the maximum eight
files in a message while leaving capacity for others. Signed offsets permit
resuming identical chunks; conflicting bytes or content digests are refused.
Staging creates no workspace artifact or model attachment. Only the owning
admission callback may consume verified complete bytes inside its transaction;
a rollback leaves the reservation available. A subsequent authorized staging
request reclaims expired or definitively finished private reservations while
retaining the durable mail receipt. The destination's file endpoint is
installed with its handler only when the owning mail service is configured.

Remote direct-thread bindings record each participant's owning machine and agent,
the wire thread's origin, and both original grants. They never create local
agent rows for remote participants. The existing mail policy checks the local
participant's eligibility and conversation ownership, rejects team/delegation
use, and rechecks current grants before allowing that thread. Address repair
preserves a binding; removal or replacing either grant makes it unavailable.
An address naming this machine normalizes to the existing local agent ID before
send identity, self-message and quota checks. The owning admission
factory in [agent-mail.ts](../src/server/agent-mail.ts) joins the authenticated
inbox transaction to those direct-thread bindings, existing quotas, held/Resume
policy and `submit()` queue or steering path. It attributes the remote sender
explicitly and retains its mail grant on the receiving run and steering input,
alongside any grant used to Resume it. Queue claims, steering consumption and
later effects recheck those constraints. Its receipt follows the original mail
and conversation as delivery progresses. File copies enter that same transaction
only after recipient policy accepts the message; a missing or incomplete copy
leaves its reservation open.

Incoming mail also shares the existing 20-message hourly allowance across all
claimed sender agents, runs and threads from one authenticated machine to one
local recipient, under the same original grants. Rotating peer-supplied IDs
cannot reset that allowance. Excess mail is held before queue/steering admission;
explicit Resume grants a fresh allowance for that machine/recipient pair while
other held threads still require their own Resume. The ordinary per-run, agent
pair, thread and bounded inbox/queue controls continue to apply.

The [outgoing mail service](../src/server/fleet-mail-origin.ts) stores
sender attribution and the original connection/native generation in the same
transaction as local mail acceptance. Held mail enters the peer outbox only on
explicit Resume. A pause holds new messages; previously accepted or explicitly
released pending mail can drain while later held mail still requires Resume,
matching the local pending-mail sweeper. A remote Resume's command and grant are
stored with each released outgoing message and checked before transmission;
they do not constrain unrelated messages from the original sending run.
Remote Resume is an explicit `act`-scoped destination command, including when
it restores a mail allowance; its authority is retained through later delivery.
The [drainer](../src/server/fleet-mail-drainer.ts) runs at most
four deliveries, with persisted 15-second to 5-minute retry delays, and rechecks
sender cancellation, retirement, conversation, generation and all inherited grants before
transmitting an envelope. Completed intents survive an idle harness restart.
Lost outcomes stay unconfirmed until a signed destination receipt resolves them;
cancellation cannot turn a possibly delivered message into a definite refusal.
Receipt reconciliation and its backoff survive deletion of the local thread.
Destination acceptance updates mail status without creating a local recipient
run or making a remote conversation navigable through a local ID.
An interrupt receipt retains its message's target without binding an unresolved
ordinary thread default.
Receipt and local-refusal changes mark their visible projection in the same
transaction. Each drainer pass recovers up to 100 pending projections, including
terminal receipts no longer awaiting transport, without contacting the peer.
An unchanged successful poll clears a prior transport error; otherwise it leaves
thread activity and Feed invalidations unchanged.

Outgoing envelopes capture authorized published or attached files by owning
machine, immutable content digest, size, name and media type. The sender uses
the same [file forwarding policy](../src/server/agent-mail-files.ts) as local
mail and reads bounded original bytes before transfer. An unrelated artifact
or an attachment from refused, cancelled or uncertain mail grants no forwarding
access. Removing a publication refuses a still-unsent envelope; it cannot turn
an uncertain delivery into a definite refusal.

The [mail directory](../src/server/fleet-mail-discovery.ts) lists
authorized machine identities without network requests. `loop_agents` keeps its
local query/offset/limit behavior; an explicit `sourceId` reads one destination's
signed directory, qualifies its agent IDs and reports that machine's
availability separately. An offline destination never blocks local discovery.
The tool rechecks its owner, original connection and active native generation
before publishing a remote response. Source names are display labels, and the
directory exposes neither peer origins nor credentials.

The companion's private execution IPC carries a
bounded discovery catalog and correlated reads to the host-owned mail transport.
The host repeats owner, run, connection and native-generation authorization
before peer IO and after the response. Neither origins nor peer credentials
cross into the tool worker. The owning service observes committed directory
changes and refreshes an already running worker's catalog. Updates coalesce;
service replacement or worker retirement rejects outstanding reads without replay. Each side allows
at most sixteen outstanding reads with a 45-second IPC deadline. The host retains
its slot until the underlying read settles, including after an IPC timeout.
Normal companion startup configures the bridge before opening the execution
worker. Isolated previews do not install it.

The [mail service lifecycle](../src/server/fleet-mail-services.ts)
composes that bridge, destination policy, discovery and autonomous delivery with
the companion's shared tunnel capacity. Construction starts no delivery or
tools; the lifecycle starts them after its peer gateway listens and removes them
on shutdown. Shutdown invalidates outstanding worker reads and closes the peer
transport without removing a replacement lifecycle's tool binding. The normal
host mounts the fixed mail endpoints alongside the workspace peer protocol;
each requires its own current mail grant, separately from read or act access.

The [mail file staging store](../src/server/fleet-mail-files.ts) retains private
copies behind the fixed peer file endpoint. Every 192 KiB chunk is
bound to the authenticated mail grant, original envelope digest and active
destination reservation. Both machines recheck their current file-sharing
grant. Declared sizes reserve at most 256 MiB across the receiving machine;
incomplete copies expire with their reservation. Complete bytes are hash checked
before a synchronous database copy inside recipient admission. Chunk transfer
alone creates no artifacts, conversation attachments or model-context access.
Lost chunk acknowledgements resume that reservation; lost acceptance reconciles
the original receipt without reading the source files or copying them again.

Peer credential primitives bind destination-issued, ten-minute access to the
enrolled machine key, destination grant, operation and accepted directory.
Signed challenges use a short-lived nonce bound to the issuer instance and its
monotonic deadline; successful proof redemption persists nonce consumption and a
hashed credential in one transaction. Credentials expire on gateway restart;
durable grants permit fresh machine-to-machine renewal. A durable issuer fence
prevents a replaced instance from issuing against cleared nonce receipts.
This fails closed when
elapsed monotonic time cannot be recovered after a stalled wall clock or reboot.
An issuer clock rollback also fails closed. A fresh client nonce binds each proof
to its response. Client acceptance subtracts round-trip latency and returns local
monotonic expiry and renewal deadlines, with renewal due two minutes before
expiry. Versioned pairing link parsers project the device and enrollment
capabilities separately. The companion gateway's transactional device pairing is
described in [pairing](pairing.md), together with the dedicated peer enrollment
protocol. Dedicated credential challenge/issue routes reject browser credentials
and expose no workspace administration. The companion owns one demand-created
lease per enrolled peer and operation. Leases renew from two minutes before
expiry with jitter and bounded retry backoff, independently of the browser.
An uncertain issuance obtains a fresh challenge; an agent action is never retried
by the credential worker. A valid credential retains its original expiry during
failed renewal. Status exposes availability and remaining lifetime, never tokens.

A partitioned replica may continue honoring and renewing a previously approved
grant until it receives the signed removal. Ten-minute credentials bound reuse
without successful renewal; they are not a global revocation deadline. The
directory outbox retains unacknowledged removals. Each destination enforces its
latest accepted directory, and a tombstone already known locally cannot be
overridden by an older admission proof or credential.

Committed local authority changes notify lease owners after the outer synchronous
transaction completes. Rolled-back changes produce no notification. Removal closes
affected leases; repair invalidates old-address callbacks and obtains credentials
for the new signed context. Dispatch also rechecks the current head directly, so
it does not depend on notification timing. These notifications cover writes through
the gateway's authority instance; they are not a cross-process event transport.

Destination enrollment preparation proves the controller key and consumes a
local ceremony with a pending grant in the same database transaction. Only the
bound signed directory revision activates that consent. Signed receipt queries
reconcile a lost response without replaying an effect. Cancellation leaves the
capability spent, and a newly redeemed local ceremony supersedes older pending
consent. Address repair retains the identity and grant; explicit recovery needs
fresh destination consent. The dedicated peer protocol exposes these operations
without browser credentials or local administration access.

Controller enrollment jobs record their exact confirmed input and dispatch
identity before sending a capability or commit. Destination identity proof
precedes capability release. An uncertain prepare or commit is reconciled by a
signed receipt query; restarting or retrying the job does not resend that effect.
The pending operation reserves directory administration until publication or
cancellation. Publication releases that reservation so an unavailable destination
cannot block a later removal. A replacement instance fences older in-flight
callbacks, and the first commit dispatch rechecks membership and authority.
Receipt reconciliation can use a repaired canonical origin for the same key
while preserving the original operation, intent and signed query. Controller
jobs use the authenticated local-device administration API described above;
peers cannot administer them. The browser controls use that same local-device
boundary; see [Add and manage machines](pairing.md#add-and-manage-machines).
The dedicated fleet HTTP protocol and its admission limits are described in
[pairing](pairing.md).

## Saved rows

[Typed readers](../src/server/row-schemas.ts) validate persisted execution payloads and JSON metadata once, preserving owner predicates. Team setup, saved agent definitions, workspace content and continuation routes, artifact filing and PR-watch registration use the [owner-scoped readers](../src/server/domain.ts) before changing configuration or organization. The generic ownership guard returns `unknown`; execution uses one parsed `Run` and the [legal state map](../src/shared/run-state.ts). New records and update patches are strict; subscription status refresh preserves existing validated metadata while validating its new status fields. Saved execution payloads reject unknown fields. Metadata readers retain additional fields used by imported content while rejecting malformed identity, routing, permission and credential fields. Model catalog entries are strict; only an absent model display name defaults to its ID. Execution projects known fields into new output, leaving the saved historical payload intact. Invalid records fail closed with their row ID; malformed team configuration also remains unavailable for deletion and filtering. Artifact responses retain serialized metadata; continuation copies validate selected messages before creating a conversation and preserve historical extras inside their original metadata. Folder ancestry is validated when changing the parent; renames do not depend on unrelated ancestor display fields. Import cancellation checks ownership and scalar run identities without interpreting execution payloads or damaged import display fields; starting an import still validates its record.

Cancellation, dismissal, approval rejection, revocation and native interruption use owner-checked control fields without executing or repairing an invalid payload. Resuming or retrying saved work still requires its full validated row. A new turn validates only the prior folder and review identity it carries forward, then builds a fresh snapshot from the current agent and connection; invalid carried identities remain unavailable. Subscription logout validates owner, provider and routing separately from unused catalog, display and provider-secret fields. Explicit disconnect clears recovery markers in valid metadata even when routing is invalid, so startup cannot reconnect it. Teammate listings mark each damaged connection unavailable without blocking healthy peers. Background-result delivery reads owner-checked sender identities and outcome fields without executing its payload; uncertain sender locations are labelled unverified, while recipients still validate fresh execution data. Worker failures can end only the lease they still own; unleased malformed queue entries are rejected before dispatch. Public projections retain serialized JSON and never expose credential rows.

## Workspace HTTP contracts

The [workspace contracts](../src/shared/workspace-api.ts) describe the public bootstrap, agent, connection, message, personal, Feed, Later, saved, scheduled-send, conversation, run, Results, folder, artifact, upload, search, preference, import, approval, native-decision and session-control endpoints. The [registrar](../src/server/registrar.ts) keeps each Express router private and exposes only its mount handler. Contracts are the only registration path; [Contract rules](contracts.md) defines the authoring rules. Contract handlers validate inputs through the existing error middleware and validate and project JSON responses. Undeclared response fields are removed; invalid output produces an unavailable-response error without exposing its contents. Attachment routes use `kind: "stream"`: inputs are validated, the existing response writer is preserved, and typed browser helpers return a Blob. Browser file links use `routeUrl`; previews that need attachment headers use the stream-only `fetchStream` helper. Binary redirects are accepted by the Blob reader only when the final response stays on the same origin and workspace API source. Multipart routes declare `multipart: true`: the body schema describes text fields, and the typed client sends one Blob part named `file` without setting a JSON content type. Existing upload middleware still owns size limits and runs before contract validation. Query arrays retain repeated keys. Authorization stays with the paired-device admission and owner-scoped handlers. App-level registrars defer automatic `OPTIONS` responses to the enclosing admission and fallback chain; existing child routers keep their method responses. Feed, conversation and Results handlers remain synchronous inside their existing snapshot transaction so their bodies and watermarks describe the same committed state.

These schemas describe wire data independently of storage rows. Existing JSON columns remain serialized and nullable joins stay nullable. Every response requires fields emitted by all current producers; optional fields represent current conditional metadata, never implied capabilities. A missing Feed pull status remains unknown, distinct from an explicit null meaning no watch. A public run state may include presentation values such as `waiting_children`; reading it does not authorize execution. Session controls share a public catalog schema with the execution boundary, without exposing its private operations or credential contracts. The [client helpers](../src/client/workspace-api.ts) infer request and response types, preserve source-bound transport and read cancellation, and never retry writes automatically. The exported transport helpers accept only contracts. Local input-validation failures are definite refusals with readable messages; a malformed acknowledgement remains uncertain.

The single [workspace registry](../src/shared/workspace-api.ts) defines workspace and Cards contracts and generates [OpenAPI](openapi.json) plus its [event-channel companion](openapi-channels.json), checked by `npm run openapi:check`; integration bearer access follows each mounted contract’s `{ admits }` values at both the server and paired host, as described in the [Integration API](cards-api.md). Transports, peer and fleet routes refuse integration bearers; read grants admit only declared read contracts. `status` and `additionalStatuses` document existing response statuses without changing handler status selection; scheduled-send creation uses 201 for a new row and 200 for an idempotent replay, while health reports its structured readiness response at 200 or 503.

Application discovery, health, build identity, diagnostic runs and HTTP event polling use the same contracts. The event fallback retains its array of owner-scoped rows and serialized payload text. Automatic snapshot reads that exhaust transient server retries or fail on a network error register recovery interest for their source and owner generation. The shared watcher probes HTTP while that interest exists, even with a connected socket; a successful empty poll invalidates the failed source too. Recovery interest is tracked per request path within each view signal: a successful read clears that path without clearing another failed read, and only the newest overlapping request may settle its interest. Cancellation drops the view’s interest, owner changes discard it, and successful recovery returns to push-only operation. Permanent refusals and writes do not register recovery. Recovery invalidates the whole source because the shared reader does not own collection subscription identities. Persistent failures therefore cause repeated refreshes of healthy collections too. Requests retain their bounded transient-error delays and source notifications are throttled, but recovery cycles have no increasing backoff or terminal retry cap: a cap could leave a quiet failed view stale indefinitely. Readers outside the collection hook, including Approvals, still cancel on each relevant signal and can delay a slow response under sustained invalidation. Ordinary socket frames leave recovery probes running; resets and socket readiness still cancel obsolete fallback probes. Collection reads coalesce automatic invalidations received during a pending request into one trailing refresh, so repeated recovery cannot starve a slow healthy read; selection changes, unmounts and explicit retries retain cancellation. A contract declaring `kind: "transport"` hands its protocol handler raw requests, including validation, errors and streaming; no workspace route currently does. The paired host authorizes devices, origins and CSRF before forwarding, and the app serves the paired owner. The session GET projects only the shell's user id/name and the `paired` mode.

## Execution paths

### Local control transport

[local-control.ts](../src/local-control.ts) sends JSON control requests over loopback TCP or a Unix socket. Host administration, connection-service operations and backend probes share response decoding, bounded buffering and error settlement. Responses are decoded once after collecting complete UTF-8 bytes. Callers retain their endpoint budgets: host responses allow 1,000,000 bytes, connection responses 100,000 and probes 1,000; timeout choices remain at the caller. HTTP error messages and status codes reach the caller, while malformed, oversized, interrupted or timed-out responses reject the attempt. The transport never retries a request; callers must treat a lost response to a mutation as uncertain.

The same library handles control-server dispatch, JSON replies and timing-safe authentication. Authentication compares UTF-8 byte lengths before comparing bytes. Host bodies require non-empty `application/json` and allow 100,000 bytes; connection-control bodies allow 16,000 bytes and treat an empty body as `{}`. `Problem` status and safe messages cross the boundary, while diagnostics and arbitrary exceptions do not. The relay shares JSON replies and the private probe header; its unknown-outcome and reconnecting responses retain their distinct headers.

[Local startup](../src/local-startup.ts) owns detached spawning, private log descriptors, readiness IPC, startup timeout and listener cleanup. The CLI forwards terminal interruptions only while awaiting readiness; the connection service remains in its own process group across application restarts. Callers retain their timeout messages and interpret readiness payloads, including the connection lock-busy outcome. Child entrypoints report once and disconnect IPC after sending; importing an entrypoint does not start it.

### Agent sources and execution environments

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

API connections use Loop's model loop. Native connections dispatch through native adapters. Native context belongs to its harness; Loop persists the display projection, dispatch identity, approvals and tool receipts. Codex, Claude Code, Pi and Muse Code support live input; OpenCode, Antigravity, Grok Build and ACP queue follow-ups. Each native conversation has an independent session and serialized turns.

Native prompt, live-input and answer methods accept a synchronous dispatch guard from their owning runtime. Adapters recheck it immediately before native submission, including after account/configuration reads, interruption confirmation or queued preparation. A refusal prevents that submission and leaves unsent decisions pending. Callers without a guard retain their existing behavior; a guard does not replay an uncertain native effect. If Pi ends a turn with guarded input still queued, Loop preserves that native queue and reports an unconfirmed outcome. Pi exposes no durable per-entry identity, so Loop cannot safely clear and restore a queue shared with another native writer.

Core dispatch, steering, decisions and dependent work use the database-free [effect authority interface](../src/server/effect-authority.ts). Database startup installs a local guard that refuses recorded delegated work; the workspace and execution-worker composition roots install fleet authority only when enabled. Definitive non-delivery recovery and execution-grant validation use the same interface.

The internal [fleet effect store](../src/server/fleet-effect-authorizations.ts) binds creator and editor grants to an owner, effect kind and durable effect identity. Acceptance and inheritance require an owning database transaction. Revalidation checks every retained grant, including editor-only and inherited constraints. Reusing a contribution command with a different grant is refused; inheritance detects those conflicts and rolls back with its owning transaction. Definitive non-delivery recovery can discard only a newly inserted edit, inside its recovery transaction; an idempotent duplicate cannot discard a pre-existing contribution. The authenticated action context is supplied by trusted server code, never by a request header. These primitives do not mount a peer action route or install a native runtime caller by themselves.

[native-sessions.ts](../src/server/native-sessions.ts) is the stable import facade. Its [supervisor](../src/server/native/supervisor.ts) owns live sessions, generations, execution, settings, idle disposal and recovery. The same instance supplies its live-session map and callbacks to the [projector](../src/server/native/projector.ts), [decisions](../src/server/native/decisions.ts), [Pi customization](../src/server/native/pi-customization.ts) and [projects/catalogs](../src/server/native/projects.ts) modules. [Workspace preparation](../src/server/native/workspace.ts) shares the existing identity and checkout checks. Worker ownership remains at the execution authority boundary described below.

The private native tool bridge gives ordinary harness runs the same owner-scoped agent directory, direct/team mail, handoff, memory and published-file tools; delegation remains a team-manager operation and snapshot reviews keep their restricted catalog. [Agent messaging](workspace.md#agent-messaging) preserves local owner isolation; direct mail and handoffs can target explicitly authorized fleet peers. Team and delegation operations remain source-local. Direct threads have two fixed participants and conversation bindings. Pending mail is durable; the atomic queue claim serializes mail against conflicting agent work and rechecks authorization before dispatch. Team mail retains membership checks. Handoffs transfer a task and context summary without transferring a provider session or additional authority, and file access is checked on forwarding and reading.

### Companion execution authority

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

## Workspace updates

The webhook outbox records `run.stopped` deliveries with the run transition and its change-log ID in one transaction. Activated and failed subscriptions retain one delivery identity per transition; failed subscriptions keep accumulating a backlog. The worker’s maintenance pass shares scheduling with Web Push while each delivery path keeps its own tables, claims and retry policy. Webhook subscription and delivery writes commit scoped `webhooks` invalidations through the database change log. Lease expirations add restart-safe notification obligations to the shared deadline scheduler; processing them changes neither the lease nor delivery state. Settings list and selected delivery history use independent shared read executors, retain their own errors and refresh from source-scoped notifications and shared disconnect/deadline recovery, without a separate interval. Explicit actions supersede older read snapshots while preserving their durable command identities. Webhooks use sealed signing secrets, fenced leases, installation-dependent destination checks, same-identity retry and visible exhaustion in Settings; [Integration API](cards-api.md#outbound-webhooks) defines activation, payloads and receiver verification.

The signed-in UI consumes an authenticated event stream for each execution source. Companion pages use the gateway multiplex transport described above. The paired host also serves the current v3 `/ws` transport and forwards source event connections through its discovery and device authorization boundary. Integration tokens cannot open these connections. Owner-scoped change-log cursors notify projections when committed data changes, including saves, dismissals, metadata, mail, Social and pull-request state. The API observes the shared SQLite database so updates from a separate worker are included.

Read integration tokens use the separate WebSocket channel `/api/events/stream` and the existing HTTP event page. The token socket shares the browser's v3 drain and frame serialization; each token persists only its confirmed epoch/cursor and the current connection identity. Offered frames remain connection-local until an acknowledgement on the same socket. Both listeners own and close their token sockets during shutdown, including the companion behind its Unix-socket relay. See [Integration API events](cards-api.md#event-pages-and-streaming) for replay, reset, byte limits and idle revocation.

Each process owns one [ordered change drain](../src/server/changes.ts) on its database connection. Local event inserts schedule a macrotask; one shared check of `PRAGMA data_version` and `total_changes()` every 250 ms wakes the same drain for foreign commits and local SQL-trigger producers (`LOOP_CHANGE_POLL_MS` configures that interval). At startup it reads the committed event tip; consumers obtain older state through their own initial snapshots or replay. Subsequent ascending reads alone advance the cursor, so rolled-back savepoints never publish and a local commit cannot skip an earlier foreign row. Failed reads retry after 100 ms independently of the foreign-poll interval; invalid timer values use the default interval. Bounded pages yield between deliveries. Publications contain row identities and types; payloads stay behind each consumer's byte limits. Owner subscriptions do not replay history on demand: sockets retain independent durable cursors and drain their own replay pages. Source-row triggers write identity-only invalidations in the same transaction as the existing Cards and Done revisions. Later also tracks target content, agent and project labels, run folder context, and story-feed access. Healthy Social refresh timestamps and cache validators do not publish changes; story content and feed-health changes do. Social digest settings and worker status changes also invalidate Social. Deletes write tombstones before cascades using a surviving collection subject and no run foreign key. Before an owner has any events, HTTP clocks read an implicit zero watermark from a persisted database identity without writing. The first event or socket initialization stores that same epoch in the owner’s row. A durable per-owner `change_watermark` retains its epoch and last event ID even when events are pruned; sockets reconcile holes without sending empty event frames. Socket authentication, session checks and overflow resets remain at the transport boundary. Existing owners connect without a writer lock; failed first-clock initialization closes the socket and releases its subscription and owner reservation.

Workspace writes use the synchronous boundary in [projected-database.ts](../src/server/projected-database.ts). Use `db.transaction(...).immediate()` for a group of changes; standalone prepared writes are wrapped automatically. The Feed projector drains deduplicated dirty conversation/result identities before that outer transaction commits, together with its `feed.card` events. Nested rollback and projector failure roll back source rows, projection rows and events together. Both API and worker import this database boundary. Direct SQL transaction-control statements and lazy write iterators bypass that contract and are rejected. Approval and stopped-watch timestamps remain read-time predicates rather than stored expiry flags.

Thread and Done Feed pages, their activity counts and Done cards read `feed_cards`. Conversation pages read current run states for their working indicator, including when the transcript is anchored before that work; obsolete conversation Feed cache columns are absent. Replies retain their separate durable publication rows and unread count. Opening a Done result records it in `done_card_reads`, the source of truth; the projector copies that as the result row's `unread` flag, and a partial index over unread visible results keeps the Done count proportional to unread results rather than history. One indexed statement selects a Feed page and its summary; Social, Later and scheduled counts remain independent aggregates, and `awaySummary` stays on run history. Historical result rows preserve their run/message identity and folder while joining current thread context. Thread rows retain the displayed message and run-input prefixes, deriving titles before shortening prompts and storing shared context once; complete messages and result/idle content remain available to the detail readers. Idle rows exist only for conversations without results whose run state and Later membership permit a fallback; pending approval timestamps still resolve at read time. The projector updates only changed columns and affected result keys, so stream chunks neither rewrite historical cards nor unrelated membership indexes. Larger thread displays emit the card identity with a null inline card; the scoped HTTP page delta supplies the complete display without copying a large preview into every streamed event. Folder changes capture old and new subtree memberships; queue peers refresh only for active membership, order or connection-scope changes.

Saved Done groups use typed list and detail page routes, with at most 20 entries and 1,900,000 response bytes per page to fit the signed peer response envelope. List cursors bind the owner and selection; detail cursors also bind the group's ordered visible membership, so regrouping between pages returns an explicit refresh error. The [shared reader](../src/shared/done-thread-client.ts) keeps the source and cancellation lifetime across pages, rejects repeated cursors or incomplete membership, and retries the unpaged read only if the initial page endpoint returns 404, which a current missing source or group can produce. A single result exceeding the page budget returns an error directing the reader to its original conversation. These limits bound each wire response; group detail still reads up to 100 members on the owning server.

The [queue composition](../src/server/queue.ts) supplies explicit lifecycle and
claim-policy hooks to the [run state machine](../src/server/queue-machine.ts).
The machine owns legal transitions, owner checks and lease transactions; it does
not import checkout, webhook, mail or review implementations. In a transition's
immediate transaction, the state changes, checkout capture is marked pending,
the event is written, then webhook deliveries are enqueued. Capture starts after
that inner transaction returns. A caller such as lease completion or claim
cleanup can still hold an outer transaction at that point; this is not an
after-commit callback. A failed transactional hook rolls back the transition
and prevents the capture callback. Claim policy snapshots queued mail, cancels
stopped review continuations, then refuses obsolete mail before selecting an
eligible run, all within the claim transaction. PR watches and verifications
observe completed native command output in the projector, with its generation
and record context; they are not run-state transition subscribers.

[Process records](../src/process-records.ts) owns process identity, PID namespace,
liveness, zombie detection, process-group observation, workspace locks and child
registries. It also owns forced termination, unresolved stop records and the
state-file names shared by producers and recovery readers. Log rotation and
redaction remain in [daemon.ts](../src/daemon.ts). Linux observations use
one `/proc/<pid>/stat` parser, including names containing spaces and closing
parentheses. Workspace lock recovery requires positive evidence of death or PID
reuse; an inconclusive probe retains the lock. Process-group existence and live
membership remain distinct: a group containing only zombies has no live members.

The worker coalesces scheduling wakes from queue and run-state publications, with a two-second fallback. Releasing an execution slot wakes scheduling again because a terminal publication can precede slot release. An empty claim does not schedule itself again. Stale-run recovery stays in the scheduling tick; other maintenance schedules remain independent.

The [maintenance scheduler](../src/server/worker-maintenance.ts) owns background delivery, feed, memory and search timers and their mail/artifact wakes. Delivery passes coalesce while one is active; digests and feed watches run only after a successful feed refresh. Failed background tasks report `background-task-failed` with a task name and sanitized error class/code facts, without the thrown message. The [run lease timing](../src/server/run-lease.ts) derives the stale threshold from six heartbeat intervals: the heartbeat remains ten seconds and the threshold one minute.

Active consumers share one [run subscription](../src/server/run-signal.ts) per run and process, released when its last consumer finishes. Committed run and provider-connection changes abort managed/native IO with a readable cause; steering, approval and delegation waits subscribe to changes. One two-second fallback per held run recovers missed notifications. Connection status and its owner-scoped event commit together, contain no credentials, and need no run identity. Run subjects retain their run foreign key and cascade behavior. Steering retains claim-before-delivery and never replays an uncertain handoff. Approval expiry has its own deadline. Mail and artifact publications also wake the worker's three-second maintenance pass, which remains responsible for Later and scheduled sends.

Thread openings reuse the owner's cached transcript and linked-source metadata while reconciling with the server. Only an initial unanchored read sends `resume=1`; the conversation route chooses an older saved-position page in that response and reports `resumed`, while ordinary refreshes continue to return the latest page. Explicit message anchors and history cursors keep their existing behavior. Owner changes clear cached views, and source/conversation generations discard stale responses. A source's HTTP 429 `Retry-After` pauses its reads, including fallback polls; domain refusals without that header retain their actionable error and do not impose a cooldown. Scheduled-send and review-status reads also recover at the deadline with view-bound cancellation. Zero, past, or malformed retry deadlines have a one-second minimum. Approval polling reports cooldowns quietly and clears recovered read failures independently of action errors. Cached threads stay readable and retry at the deadline. Failed linked metadata refreshes retain a visible connection retry alongside the transcript, so updated agent settings can recover without reopening. Writes are never automatically retried by this mechanism.

The registry’s `channels.events` entry shares the V3 frame, event, capability and clock schemas with the socket transport and browser parser. Its `fallback` points to the existing `events` HTTP route; `workspaceRoutes` exposes only HTTP entries for registration and generation. Channel documentation references the HTTP fallback’s raw event page without duplicating its schema. Sockets negotiate V3 with the first `v=3` query value and serialize the original frame after validation, preserving field order.

The [workspace event contract](../src/shared/workspace-events.ts) validates emitted types and their strict, bounded payloads before insertion. Native display events share ingress's 256,000-byte budget, including 64,000 bytes per request; provider IDs and list lengths remain accepted within those totals. Subjects identify owned runs, conversations, messages, artifacts, approvals, decisions, Later items, scheduled sends, mail threads, connections, agents, folders, teams, Social sources or collections. `emit` checks ownership; deletion producers can retain immutable ownership evidence captured before removal. Events carry one or more projection scopes; tombstones require authoritative reconciliation of those scopes, because removing a bookmark or nested record does not necessarily delete its underlying object. Typed message upserts, append chunks and removals name the displayed message and its content revision; native decision lifecycle events name the server decision and retain the adapter request identity as display data. Other events invalidate run, connection, conversation or collection state. Browsers request `v=3`; fleet subscriptions use the same workspace event contract. V3 frames carry parsed events with explicit scopes; invalid historical rows and unknown future event types invalidate all collections. Message upserts and decision payloads over 60 KiB become scoped invalidations before the event transaction commits; their complete content stays in the authoritative source row. Other oversized wire events become scoped invalidations without changing durable payloads. Message subjects remain available so clients can refetch retained older pages. Replay pages retain the 64 KiB per-event and 512 KiB batch budgets. Connections without `v=3` are refused with a clear protocol error.

Every supported source runs the current build and reports complete invalidation coverage and delta delivery for transcripts, Feed and Results. Partial or snapshot-only sources from earlier Loop builds are outside the [fresh-install policy](../AGENTS.md). V3 resets retain the capability fields in the shared wire contract; client views do not negotiate per-source polling from them. Every reset and events frame carries the source clock and next deadline. Notifications coalesce by source and scope, so a Feed-only invalidation does not reload a thread or another collection. Complete producers name the affected collections explicitly; message chunks update the transcript reducer without a broad refresh. The first replay frame also advertises capabilities. Fleet replay caches advance the source clock by monotonic elapsed time while preserving its absolute next deadline.

After idle, browser reconciliation starts immediately. Under sustained changes, scoped notifications batch at most once every two seconds, while broad invalidations that refresh every collection use three seconds to leave request capacity for user actions in multiple tabs. Projected display rows continue directly to their reducers; this batching applies to follow-up HTTP reconciliation.

Conversation pages subscribe before reading and buffer events per owner, source, epoch and request generation. Browser pages require a projection watermark; a missing watermark stops the read with a manual retry action. Bearer API responses intentionally omit the owner clock. The shared transcript reducer installs per-entity revisions, replays events beyond that page’s watermark, deduplicates chunks by event ID and chunk index, and checks the base revision and UTF-8 offset. A chunk gap requests the affected message’s page without expanding the displayed page ranges. Recovery tracks each missing row’s latest event cursor. Returned rows and the explicitly requested anchor are acknowledged only through the snapshot watermark, including an anchor that became hidden; typed removals clear pending recovery. Newer invalidations received during the read remain pending. Buffered gaps for messages outside a fetched page do not prevent that page from hydrating; its own gaps still require a retry. Upserts for unloaded older history remain hidden until those pages are requested. An observed row beyond an anchored page’s end requests the latest page once, after which live appends update it in place; Jump to latest also fetches that page. Invalid snapshot rows stop with a retry action; supported imported fractional timestamps remain valid. Rejected handoffs retry at most twice with backoff before showing an error. An HTTP clock from a replacement database resets the source while sockets are down, without claiming a build identity or marking the replacement socket ready; earlier HTTP responses and obsolete socket callbacks cannot restore the old epoch. A reset or bounded-buffer overflow requests a fresh snapshot; when a reset replaces loaded pages, pagination restarts at the new snapshot’s cursor. Each page declares its ordering range so absent rows can be removed without acknowledging older retained pages, and older responses cannot resurrect a deletion. Managed output commits display rows and their events together at most every 250 ms and flushes at terminal boundaries; native output retains its one-second batch. Large appends become ordered bounded durable events, each with its own reconnect cursor.

Owners whose Social reads encounter an in-progress refresh receive a completion invalidation even when stories and health are unchanged; routine worker refreshes remain quiet. Feed notifications reconcile per-page HTTP deltas through the shared Feed reducer. Each request supplies bounded known-row signatures for its exact selection and pagination boundary; the server rechecks authorized membership and ordering inside the snapshot transaction and returns changed rows, removed identities and the current ordered page manifest. Missing, oversized or mismatched known state falls back to a full page. Client pages remain separate by owner, source, selection and pagination boundary; request generations reject obsolete responses, and resets discard the affected source’s page state. Scoped refreshes retain failed sources’ cached rows and error markers until those sources recover. A Feed or Needs read entering Retry-After or transient-error recovery reports its source failure immediately, allowing healthy sources to finish. One cancellable recovery per source and page continues independently; success schedules a fresh source head read instead of applying the delayed page. Reset, selection changes and owner generations cancel obsolete recoveries. Pending head refreshes retain each source until a read of that source starts; a local-only refresh, append or save cannot discard another source’s pending notification. Feed uses the shared socket-down HTTP fallback before the first socket frame and after a disconnect or HTTP database replacement; it has no separate fallback timer. Results and Cards drain continuation pages in a bounded pass; a non-progressing cursor fails and an excessive drain restarts from a snapshot.

The Feed navigation badge keeps one snapshot executor per source. A failed source retains its cached count while healthy sources update; an independent notice retries only failed sources with a manual read. Source, filter and owner changes dispose those readers. The badge remains independent of Feed pagination and the active tab.

The snapshot read executor in [read-executor.ts](../src/client/read-executor.ts) owns cancellation, trailing-refresh coalescing, completion and error publication. Its caller supplies a lifetime predicate and state observer. The React adapter in [CollectionRead.tsx](../src/client/CollectionRead.tsx) binds that executor to the owner generation and query key, and disposes it on cleanup. Transport retries, subscriptions and domain pagination remain with their existing owners. Observers and receive callbacks may synchronously invalidate or supersede a read; the executor rechecks its lifetime before dispatch and before publishing completion. Its independent `request` tasks use the same execution and cancellation rules while returning one promise per target; they do not coalesce separate workflow reads or publish snapshot state. [SourceContext.tsx](../src/client/SourceContext.tsx) binds these tasks to the owner/source view and can link a protocol-owned abort signal. Runtime sign-in, setup and credential views reset on owner/source replacement; a project change retains the runtime-owned sign-in attempt and typed response while refetching its catalog. Authentication polling keeps its protocol cadence, and command receipts and uncertain-effect recovery remain separate from GET cancellation.

Client views use scoped signals for transcript, Feed, Results, activity, usage, decisions, approvals, saved items, Later, Social, pull watches and memory preferences. Before the first socket frame, while disconnected, and after an HTTP-only database replacement, the shared HTTP event poll refreshes those views. It stops when the current socket delivers a valid frame; visibility, online, pageshow, explicit refresh and the single deadline wake still reconcile authoritative state. Read-only snapshots recover from header-limited responses with a cancellable Retry-After wait and retry a transient server failure at most twice, including empty or HTML proxy errors. Transcript and history reads and run file lists use these bounded reads even after a run finishes. Exhausted workspace metadata/run reads retain independent visible errors and activate recovery until their own read succeeds. Collection views retain loaded rows and show a recoverable stale-view notice when those bounded reads fail. The typed `useProjectionQuery` in [CollectionRead.tsx](../src/client/CollectionRead.tsx) binds snapshot data and errors to an owner generation, source and route input. Undefined input represents no selected snapshot: the query stays idle, including manual retry, and cancels a previous selection without a manufactured resource ID. Queries without collection subscriptions still receive broad source refreshes from the shared failed-read recovery watcher. It subscribes before the initial read and uses the same cancellation and trailing-refresh coalescer as other collection reads; revisions refresh existing data, while changed query identities hide it immediately. Native decisions, personal profile snapshots and unread counts, project summaries/search and original approval details use this path. Tools keep independent snapshots for installed integrations, permission settings, native import candidates and the catalog; cached catalog entries remain visible on read failure. Preference acknowledgements replace the scoped snapshot before post-action refreshes, so earlier reads cannot overwrite the saved value. Computer status and paired-device lists use independent typed queries and errors, with revocation followed by a manual refresh. A valid profile-save response replaces the scoped snapshot and cancels older reads; obsolete owner/source/selection callbacks cannot publish it. Profile read failures have a separate retry notice, and editing waits for the first valid profile snapshot. Search preferences use this query path with owner/source-scoped edits: snapshots fill only untouched fields, reads have their own retry notice, and saving waits for a valid initial snapshot. Search-index status uses the same query and receives source-scoped workspace changes, including dedicated search invalidations committed with preference writes and changed indexing snapshots. Idle indexing passes do not emit unchanged progress. Content notifications and shared disconnect recovery reconcile counts without a separate view timer. Cards use the same executor for cancellation, errors and trailing reads; a queued Load more has priority over later background refreshes, and waiting callers settle after that queued read. CardPager retains the cached window and delta reconciliation. The app Results/Files hook owns its rows, selection, page state and foreground loading; it uses the same executor and keeps a failed-read notice during background recovery so explicit retry can interrupt that recovery. Linked thread metadata publishes bootstrap and capabilities as one cached snapshot through that executor. Its pair deadline leaves a full request window after each transport retry wait, active deadline expiry retains recovery interest while caller cancellation clears it, server cooldowns keep their visible explanation, and sibling cancellation retains aggregate failed-read recovery interest, and owner/source or disabled-scope changes cancel the pair. The agent-thread feed uses the shared paged reader for cancellation, subscriptions, coalescing and queued manual refreshes; its per-source cursors, cached loaded windows, partial errors and bounded history reconciliation remain feature policies. Invalid non-advancing cursors fail without committing that page. Saved files use the same paged reader with revision refreshes that retain visible rows until a successful first-page snapshot. ProjectFiles supplies the shared watcher's Results revision, so Saved adds no independent change or refresh subscription. Pin outcomes belong to the current owner/source/selection instance and latest attempt; obsolete replies cannot publish errors or trigger refresh. Its opt-in cursor guard rejects a repeated page boundary before publication, and append rows deduplicate by artifact identity. Multi-source envelopes retain their domain retry-boundary policies. Saved read notices remain separate from pin-command failures. Snapshot review status also uses that executor for revision reads and explicit freshness checks. Its report is scoped to the owner generation, source and conversation; ordinary status updates preserve the last freshness result for that same review. A failed status read shows a retry notice even before a report exists, and broad recovery signals remain source scoped. Their Retry connection action makes one new read without another transient-error retry budget; Retry-After cooldowns still apply. The notice remains visible during automatic and manual retries; a successful read or a different owner/source/selection clears it. Feed retries target only failed sources; page retries preserve each failed pagination boundary and read failures remain separate from command failures. Import history uses the shared snapshot query and an imports collection signal committed with preview, queue, progress, terminal and worker-failure writes. It retains loaded history during read failures and has no separate view poll. External source discovery, harness availability, deployment health and authentication progress retain their separate probes. Search query snapshots and result-open reads use this executor with explicit cancellation: Clear and a new query cancel obsolete reads, and only the current result-open request can navigate. Search keeps its existing submission/filter/explicit-refresh triggers and manual read budget; it does not subscribe to index notifications or automatically repeat failed embedding queries. Appended pages use the completed query rather than unsent text edits, and read retry keeps the failed cursor. Search view snapshots are source scoped; owner-session remounts own the form fields. Workspace metadata and active-task reads share this executor while retaining independent errors and the existing workspace invalidation watcher. Coalesced bootstrap callers receive the completed connection snapshot; owner/source cancellation rejects their obsolete return values. Composer’s accepted-receipt generation still prevents an older task read from erasing a confirmed run, and queued reads capture that generation when they actually dispatch. Recovery uses the shared watcher rather than a separate five-second error interval. Automatic reads retain recovery interest after malformed successful HTTP responses as well as network and server failures; cancellation, owner changes, manual attempts and authorization refusals do not create that interest. Artifact opening and reply reads use [ArtifactReads.tsx](../src/client/app/ArtifactReads.tsx) with separate shared-executor lifetimes and retry notices. A newer open or reply intent cancels obsolete reads and notices across both flows; direct artifact links share the open lifetime, including owner expiry. Artifact read notices can be dismissed without another request. The feature renders its notice; AppView accepts a presentation slot rather than the reader controller. Card targets always use typed card detail; only artifact-shaped inputs can fall back from a missing card to artifact detail. Imported or unlinked artifacts open instead of becoming reply context. These navigation reads retain one transient attempt per explicit intent. Neither transport replays commands or other writes.

Pending approvals and stopped pull-request watches have persisted expiry obligations. Each process seeds its owner timers from durable rows, including overdue ones; SQLite serializes expiry processing across API and worker processes. Ordinary notifications first check a read-only snapshot; they acquire a write transaction only when expiry or deadline publication needs durable changes, then recheck under that lock. Expiry marks the obligation processed, invalidates the affected collections, and publishes the next deadline or explicit null in the same transaction. Approval refusal and watch visibility retain their existing read-time timestamp predicates; expiry does not authorize an external effect or invent a run-state transition. Native decisions have generation-bound expiry and no timestamp TTL. Later and scheduled sends retain worker maintenance, whose durable updates enter the same log.

Every v3 reset and events frame carries `serverNow` and nullable `nextDeadline`. Successful owner-session JSON snapshots preserve their existing bodies and carry `X-Loop-Server-Now`, `X-Loop-Next-Deadline` (`null` when absent), `X-Loop-Change-Epoch` and `X-Loop-Change-Cursor`; fleet sources project verified signed clock metadata into these headers. Integration-token HTTP responses omit these clock headers, including when an owner cookie accompanies the token. Read-token WebSocket frames use the same required v3 clock fields as owner sessions; token scopes and ownership still gate the event stream. The client owns one deadline timer per owner/source subscription, replaces it on newer clock metadata, and invalidates Feed, Results, approvals and pulls when it fires. It uses the received server-relative delay and a monotonic local timer, rejects stale responses, and checks owner/source/epoch generations. Only the resulting authoritative reads determine expiry. Conversation, Feed and Results responses read their body, entity revisions and owner watermark in one SQLite read transaction; this pins the snapshot to the same committed state as its cursor. Other JSON clock headers remain notification metadata and do not claim that projection handoff.

## Activities

Plans, tool lifecycle, diffs, command output, settings and command catalogs share [agent-activities.ts](../src/shared/agent-activities.ts). [server/activities.ts](../src/server/activities.ts) validates and persists trusted owner/conversation/run scope and serves paginated projections. [activity-bridge.ts](../src/activity-bridge.ts) supplies the shared mapping for native activity projections and historical records.

The client uses [activityView.ts](../src/client/activityView.ts) to accumulate full snapshot pages and apply incremental updates. Native tool items and MCP calls persist durable activities when they arrive; activity reads do not synthesize records from execution traces. Conversation transcripts show human messages and public agent output, including progress updates. Tool calls, raw native events and activity records stay out of the transcript, except native failure and uncertain-delivery notices. Tool calls, command output and plan progress are available from the conversation's **Tool activity** option; saved tool traces are in the agent profile’s Traces tab. Session settings stay in **Session settings**. A link to a hidden row opens the conversation where that row was. Activities are display data: Loop never applies a reported diff or uses these records as native model context.

[Conversation transcripts](../src/server/conversation-messages.ts) page through an indexed display projection whose ordering keys are maintained in the same transaction as messages. Public assistant updates live in the message store with idempotent per-run producer keys; transcripts, reply quotes and reading positions do not read execution traces. Migration 073 copies older public updates into messages while preserving their IDs and ordering cursors. Message sequences remain stable through deletion and database compaction. A run's updates group under its prompt, or under the run's first stored message when imported or replayed history has none. The page is selected before loading its content and current run/delivery state. Opening a thread loads confirmed session controls. File summaries load separately as their messages come into view; file contents download when opened. Opening **Tool activity** loads its recent activity snapshot; **Load earlier activity** requests older durable records, and is offered only while older records that view can show remain. File-change records are loaded for runs in the displayed transcript so older result chips retain their file reviews. Memory source and native-history detail selections use scoped queries. Memory editing keeps a separate draft and its revision while read snapshots refresh; changing owner/source resets that view’s drafts. A note-save acknowledgement closes only its original selection and reconciles a reselected target. Closing Memory Used cancels its receipt read and any cooldown wait. Social watch and digest settings use separate shared snapshot queries for watches, digests and feed-access preferences; a failed read retains its own notice and retry without hiding the other snapshots. Their forms reset with the owner session, and closing the sheet cancels reads and cooldowns. The main Social snapshot keeps its owner cache and optimistic story updates while the shared executor coalesces notifications into one trailing read. Filter changes, dismissals and post-mutation reconciliation supersede obsolete snapshots; the explicit refresh still asks the feeds for new items. Search keeps its 200 ms input debounce with a separate query-scoped executor and read notice. Pull-request inbox and detail reads use the shared executor; the connected inbox snapshot remains in the owner cache with its source and filter key, so returning from a detail view can reuse it. File and commit reads include the pull identity and requested SHA, and commit responses must match that SHA before display. A file query error alone does not replace its matching-head cached diffs or their open file sheets; the read notice appears alongside them. The existing parent-refresh policy is separate: a successful detail read with a new fetchedAt replaces the file-list scope and closes its sheet even if the head SHA is unchanged. File-query retention does not span that successful parent refresh. Immutable commit diffs use one-shot shared execution and retain their loaded data instead of subscribing to metadata refreshes. Expanded commit rows keep the commit SHA as their identity across background detail refreshes; a fetch timestamp does not reset that interaction. Successful explicit refresh and post-command reconciliation invalidate the loaded commit views. Thread watch queries are idle without a conversation, clear obsolete scope data and expose read failures separately from watch commands. Native-history fork receipts and command identities remain separate from preview reads.

Activity history and live-update cursors are independent. [ActivityHistory](../src/client/activityHistory.ts) uses the shared read executor for each page’s I/O, cancellation and owner-generation publication checks. Its domain queue still serializes recent, update, earlier and displayed-run file reads; refresh signals coalesce across a complete multi-page pass. Failed earlier, file and live operations keep separate retry targets, so another operation’s success cannot hide their error. Continuing live and file pages must advance their cursor; a non-advancing continuation stops with a retry notice. Closing or changing the owner/source/thread disposes its executor, including a pending Retry-After wait.

Records are bounded, versioned and keyed by producer identity. Sequence/revision checks prevent stale updates overwriting newer state; generation checks reject stale producers. Re-delivery is idempotent. Replay does not advance live tool lifecycle. Capabilities distinguish supported, unsupported and undiscovered behavior instead of fabricating results.

## Memory, tools and files

Workspace MCP connections belong to the owner and are shared by that owner's agents. Broker dispatch checks discovery, schema, ownership, connection and approval state. Command MCPs run as local subprocesses of the companion. Rich MCP Apps run in isolated iframes. See [workspace](workspace.md).

Artifact metadata is one strict schema per role (D5): the role column selects the arm the producer parses on write and the saved-row reader validates on read, and the 2b migration removed the fields no producer or reader uses. Search supports local keyword indexing in [memory.ts](../src/server/memory.ts). The worker captures changed messages and saved artifacts; SQLite triggers update the local index with each source change. Artifact content and versions remain live during streaming, but a streamed answer's search index and feed revisions keep their last snapshot until the run finishes: the artifact itself carries no partial flag (its role is declared at insert), and the churn guard follows the linked message's partial flag, so interrupted streams keep the last indexed snapshot until finalized. Results revisions likewise skip repeated partial updates. Scope, inclusion, revision and tombstone checks apply again before returning indexed candidates. Recall is untrusted historical evidence, never current authorization. Versioned notes preserve edit history.

Message attachments reach the model as file references read through `loop_read_file`. Before upload, the browser scales HEIC photos and images over 1.5 MB to at most 2048 pixels on the longest side and re-encodes them as JPEG ([imageUpload.ts](../src/client/imageUpload.ts)); GIFs, SVGs and images it cannot decode are sent unchanged. An upload error that is not Loop's JSON (a tunnel or proxy page) is shown with its HTTP status. API-key connections also receive the current turn's images and PDFs inline. Native turns receive upload references and use `loop_read_file` through the private tool bridge.

File publication validates the selected file/path, size and digest, then stores private content under the workspace data directory. Downloads require owner access. A worker path alone is not a published file. Credentials remain in encrypted server storage or their native provider homes; neither belongs in public projections.

## Dependencies and boundaries

Workspace HTTP routes are defined in [workspace-api.ts](../src/shared/workspace-api.ts) and registered only through the server [registrar](../src/server/registrar.ts), which exposes contract registration and mounting. The native paired host dispatches its device and source-management routes from the same registry, behind pairing and CSRF checks. Protocol-owned authentication and MCP transports are explicit contracts. Browser API requests use [client/workspace-api.ts](../src/client/workspace-api.ts): `callRoute` for one-shot calls, `readRoute` for cancellable reads, and contract-bound `routeUrl`/`fetchStream` for file addresses and bytes. Raw request transport stays private; pairing and CSRF bootstrap remain outside `/api`. Socket frames and paths use the registry's event channel. `npm run openapi:check` verifies the generated HTTP and event-channel documents; see [development](development.md#manual-verification) for the verification gate.

[deployment/versions.json](../deployment/versions.json) owns container provider pins. [host-control.ts](../src/host-control.ts) owns installed harness version checks. [package.json](../package.json) pins the ACP SDK. Validate each seam when updating it.

Dependencies retain their upstream licenses.

The application host is a single point of failure. Native tools are not a multi-tenant sandbox. Fixture tests establish protocol behavior, not provider availability, billing entitlement, device acceptance or deployment capacity. See [development](development.md) for verification boundaries.

Domain SQL moves into one module per primary table under `src/server/sql/`. Modules prepare statements lazily per supplied connection and parse returned rows with `parseRecord` and the canonical `QueryRecords` in [sql/rows.ts](../src/server/sql/rows.ts); partial and joined selections declare their columns beside the query. Callers retain ownership checks and transaction scopes, including `.immediate()`. The [SQL inventory](../test/sql-inventory.test.ts), run by `npm run check`, has a named file allowance that only shrinks: new files must use query modules, and a file leaves the allowance when its last direct call moves. The [column-parity check](../test/row-schema-columns.test.ts) compares every declared table record with a freshly migrated database. Migration runners, change publication and feed-projector infrastructure have explicit permanent exemptions; migrations remain point-in-time SQL.
