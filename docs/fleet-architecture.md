# Fleet architecture (experimental)

Internals of the experimental fleet mode (`loop start --fleet`): machine identity, signed directories, peer credentials, remote workspace access and fleet mail. [Architecture](architecture.md) covers the core workspace; [pairing](pairing.md#fleets-experimental) covers setup.

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
