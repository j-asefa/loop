# Integration API

Loop's Integration API admits scoped bearer credentials through the mounted
[workspace contracts](contracts.md). Each admitted route declares `{ admits }`;
a token may use it when at least one stored admission value matches. Session
access keeps its existing rules. GET and HEAD share authorization; HEAD has no
body. Token reads do not save, mark product items read, resolve decisions or
dispatch work; the event acknowledgement confirms only that token's stream cursor. Responses omit owner-session clock headers and the JSON
`projection` clock; collection cursors remain available for pagination.

## Integration tokens

This contract targets fresh installations: a new data directory and newly paired
devices, with every fleet peer on the same build. Credentials and pending
creation receipts from earlier Loop versions are not supported. Only
`loop_token_` integration credentials with the scopes below and `loop_hook_`
webhook secrets are created or accepted. Retired grants (`results:read` and
`cards:read`) are not valid stored token metadata. Keeping the historical SQL
migration chain does not add an upgrade path for those old credentials: on a
fresh database, those migrations have no existing tokens to transform. Current
creation retries, metadata listing and revocation remain part of this contract.

Open **Settings → Integration tokens**, name the token and select its scopes.
Read workspace is selected by default. Send and control runs is optional;
Answer approvals is unchecked and warns that the script can authorize tool
calls and answer native decisions. Select it only when the script should make
those decisions.
Copy the secret when it appears; Loop stores its SHA-256 digest and cannot
display it again. Keep it in a script's environment or secret store and send
`Authorization: Bearer loop_token_…`. The same Settings page lists nonsecret
metadata and revokes tokens immediately.

| Selectable scope   | Current admission                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read`             | Bootstrap; agent details, messages and traces; Feed pages; conversation and message reads; run and approval lists; companion native-decision lists; Results, artifacts and file downloads; Cards Results, Saved and Sent; event pages and stream |
| `write`            | Submit messages and replies; cancel or dismiss runs; reorder, withdraw or move queued runs                                                                                                                                                       |
| `approvals:decide` | Decide API approvals and answer companion native decisions                                                                                                                                                                                       |

The `read` approval list returns pending records using the
[shared approval state union](../src/shared/approval-contract-schema.ts); see
[approval states](state-machines.md#approvalsstate) for its result and expiry
fields. The `approvals:decide` response is `{ ok: true }`. Native decisions use
a separate schema and the companion's owner-scoped decision routes.

The generated [OpenAPI document](openapi.json) lists the exact admission values
on each operation as `x-scopes`. An omitted admission means session-only access.
Transport, peer and fleet routes never admit integration credentials. The
bootstrap projection includes public connection labels, models and status;
connection management and credentials remain unavailable to tokens. Native
decisions use the companion’s owner-scoped routes.

Write authority includes each mutation's public response: submit and move return
current run content, including when submit steers existing work, and withdraw
returns the draft content. These responses do not require `read`; that scope
admits the separate GET/HEAD routes.

The session-only Cards Done collection remains unavailable to every bearer, including `read`.

Tokens cover the owner's projects. Query filters narrow a selection, not
the grant. A token belongs to one source and owner; it cannot reach linked
sources or proxy requests. Additional routes require explicit contract admission.

An Authorization header selects token authentication before any browser cookie.
Malformed schemes (including Basic), invalid/revoked tokens and insufficient
grants never inherit the session's permissions. Gateways must consume their own
Authorization credentials before forwarding browser traffic. The integration path admits only declared reads and writes. Source
proxies, token management and session-only routes refuse every token. Bearer writes require neither an Origin header nor paired CSRF credentials;
a supplied disallowed Origin or cross-site Fetch Metadata is still refused.
Ordinary owner and paired sessions retain their origin/CSRF rules.
No third-party browser CORS or OAuth flow is provided.

Owner sessions manage tokens with `GET /api/card-tokens`,
`POST /api/card-tokens` (`{ request_id, secret, name, scopes }`) and
`DELETE /api/card-tokens/:id`. Creation returns `{ token, secret }`; list returns
only token metadata. At most 50 tokens may be active; recent revoked metadata is
retained in a bounded history. Nonsecret creation identities and secret digests
are retained to prevent reviving a pruned revoked credential, including under a
new creation identity. Secrets are never put in URLs or browser storage. The Settings client generates a
32-byte random secret and a UUID creation identity before sending the request.
Retrying the exact request returns the same token; changing its fields or retrying
a revoked identity returns 409. `integrationTokenRequest(name, scopes)` supplies this request shape for
session-authenticated tools. Keep the creation receipt only
in memory. If a response is lost, Settings reconciles the metadata list and can
finish the same creation; closing and reopening Settings retains a pending
receipt for that owner/source. Reloading the page discards secrets: revoke any
uncopied token using the metadata list and create another.

Requests are limited to 120 per token and 600 per owner per minute. A 429 response
includes `Retry-After: 60`. The approximate `last_used_at` updates at most once a
minute; each request still checks revocation. These bookkeeping tables are the
only state changed by ordinary token reads, along with source/owner-bound identifiers of
cards, Results and artifacts previously returned to that token. Removal responses expose only those
previously disclosed IDs; they never reveal IDs of private uploads or other
ineligible records. This read bookkeeping is discarded on revocation. After
changing credentials, backfill the selection again before consuming changes;
revision reuse across different tokens is not a substitute for that backfill.
GET and HEAD have identical permissions. HEAD does not record item disclosures,
because it returns no body; use GET before consuming removal notifications.

Read-disclosure storage grows with distinct cards returned per active token;
repeated reads do not add duplicate rows. Keep only the integration tokens you
need and revoke unused ones. These short, indexed bookkeeping writes share the
database write lock with the worker; the rate limits bound their frequency.

## Event pages and streaming

`GET /api/events?after=ID` returns the existing array of owner-scoped event rows,
including serialized `payload` text. The last row's `id` is the next cursor.
Read tokens receive at most 200 rows and a 512 KiB serialized array budget.
Rows stay whole: if the first unread row alone exceeds that budget, it is returned
alone and intact, so a client always makes progress. Browser event pages retain
their existing 200-row behavior. GET and HEAD require `read`.

The `read` scope includes committed owner-wide deadline events. Their payload
contains `serverNow` and one `nextDeadline`: the minimum unprocessed approval or
pull-watch expiry timestamp, or null when none remains. It names no individual
approval or watch. Expiry invalidations also name affected collections, including
`pulls`. These event payloads stay intact, as they do for the browser. Ordinary
bearer responses still omit the automatic workspace-clock headers; granting
`write` or `approvals:decide` alone does not grant events.

`/api/events/stream` is a token-only WebSocket endpoint. Send
`Authorization: Bearer loop_token_…` in the upgrade request using a WebSocket
client that supports headers; it needs no cookie. Use `wss:` for HTTPS origins
and `ws:` for local HTTP. Tokens are never accepted in URLs. WebSockets support
Loop's default Quick Tunnel connection; Cloudflare documents that
[Quick Tunnels do not support SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations).
Each server text message is the canonical v3 frame from the same ordered committed change drain as
the browser socket. This includes projected message content and decision payloads.
Individual event and batch byte limits can replace content with a scoped
invalidation; read the corresponding route for authoritative full content.
The browser `/api/events/ws` and companion `/ws` protocol is unchanged and still
refuses bearer credentials. See the [channel document](openapi-channels.json).

The JSON `cursor` is **offered** progress. Writing a frame to the connection
does not confirm its delivery. After processing a frame, send this JSON text
message on the same socket, using the frame's values:

```json
{ "type": "ack", "epoch": "EPOCH", "cursor": 123 }
```

The server saves this token's **confirmed** checkpoint. Confirm only after
reconciling through the routes when the frame is a reset. There is no separate
HTTP acknowledgement endpoint or acknowledgement receipt; a lost confirmation
can cause replay after reconnect. Batch
acknowledgements within the existing per-token request rate; one confirmation
covers preceding offered frames from that connection and epoch. A stale,
unoffered or replaced-connection acknowledgement closes the socket without
advancing its checkpoint. Other client messages, binary messages and messages
larger than 1,024 bytes are refused. Ordinary GET/HEAD requests without an upgrade
return 426 after admission, without advancing a checkpoint or replacing a socket.

A bare reconnect resumes from the confirmed checkpoint; `?after=ID` requests
retained history from another cursor, including an earlier point. A frame lost
before confirmation can therefore be delivered again. Consumers must tolerate
duplicates. Two tokens have independent checkpoints. Only one connection per
token may offer or confirm frames: a new connection closes the previous local
stream and invalidates its confirmations. Reconnect to the serving API process
after a restart or proxy change; an acknowledgement cannot revive a closed stream.

The first bare connection sends a reset. A normal server restart retains the
durable epoch and resumes confirmed history. A changed epoch, pruned history,
out-of-bounds checkpoint or missing log tail instead sends the same explicit
reset as the browser channel. Deleted history is not recoverable from the stream;
reconcile through the routes and then confirm the reset's tip. Reset delivery
alone never advances the saved checkpoint.

Authority is rechecked before each frame, on acknowledgements and every 25 seconds while idle, so
revoking a token ends an idle stream within 30 seconds. Slow connections close
on the shared output buffer bound or after 1,024 unconfirmed frames, discarding
buffered output when closed; reconnect from the confirmed checkpoint. Cursor state is removed when the token record is
pruned. Upgrade requests and acknowledgement messages share the normal per-token
rate limits. Both server and companion shutdown close their token sockets,
including when the companion is reached through its connection-service relay.

## Write identities and replay

Every admitted write requires a body identity. Use `idempotencyKey` (8–150
characters) for submit, cancel/dismiss, reorder, withdraw, move and API approval
decisions; native answers use their existing UUID `commandId`. The generated
operation names the field in `x-request-identity`. Session callers may continue
omitting identities on routes that previously allowed it.

An identity belongs to one owner and token. Reuse it only with the same operation
and validated params/body. Different input or another operation returns 409.
A completed replay returns the original HTTP status and current public result
without repeating the effect. Submit retains its owner-wide key: two tokens of
the same owner submitting the same work and key receive the same run. Replies,
including durable steering of active work, use the submit operation.

Local changes and the completion receipt commit together. Native answers record
a pending receipt before dispatch. A pending replay returns an uncertain-outcome
409 and never dispatches again; inspect the workspace through ordinary reads.
Do not automatically replace an uncertain key with a new one. A missing result
returns an unavailable-result 409. Withdraw retains the original public draft
response with the cancelled run's ID, so a lost reply can be recovered without
withdrawing again or creating another draft.

The replay window ends after 24 hours. Each write prunes expired completion data
for that credential, retaining a compact marker; expired identities return 409
and never become new work. Inactive or revoked credentials can retain full
receipts until another write or credential pruning; this is not a timed physical
deletion guarantee. Credential deletion cascades to its receipts, while markers
remain for as long as the credential can authenticate.
Pause, resume, retry, Later and scheduled sends remain session-only. Token
management is available only through Settings and owner-session management routes.

## Outbound webhooks

In **Settings → Integration tokens → Webhooks**, add a receiver URL, copy its
signing secret and configure that secret at the receiver. Loop first records a
`pending_activation` subscription and an activation ping. Only a 2xx response
within ten seconds activates it. If the receiver needs its secret configured
first, leave the subscription pending, configure the secret, then select
**Retry deliveries**. This reuses the original ping; it does not activate the
subscription by itself. Secrets are sealed at rest and appear only in the
creation workflow, including recovery of that same creation request.

Management is session-only on the source that owns the subscription. Integration
bearers, including `write` and `approvals:decide`, cannot manage webhooks or read
delivery history. There is no webhook CLI or destination-policy setting.
Creation and every management mutation carry a UUID `request_id`; an uncertain
client retry must reuse the same identity and input. Changed input conflicts
with 409. Updating kinds affects future stops, while already queued deliveries
retain their identity and payload. To change a receiver URL, revoke it and add a
new receiver. Revocation is terminal.

| Installation | Receiver destinations                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Companion    | HTTP or HTTPS on any port for loopback, RFC 1918 and IPv6 unique-local addresses; public addresses require HTTPS |

All installations reject embedded URL credentials, fragments, link-local,
unspecified, multicast and other non-public special address classes. IPv4-mapped
IPv6 addresses receive the IPv4 rule. Every resolved address must be permitted;
each attempt resolves again and connects using only those checked addresses,
with the URL hostname retained for TLS verification. Redirects are never
followed. A destination that becomes forbidden is recorded as blocked and is
not retried automatically. Retry first checks the destination policy again.
Settings identifies local receivers and displays the rule supplied by the
installation, not a caller-selected policy.

The only event kind is `run.stopped`, version 1. The producer records its outbox
rows in the transaction that changes the run state, independently of Feed
visibility or filtering. `event_id` is that transition's committed change-log
ID. Each activated subscription has one delivery for that event. A pause,
resume and later completion produce two different events. The schema is
[`WebhookStop`](../src/shared/webhooks.ts):

```json
{
  "id": "131f3904-a727-4ec7-8f63-90e012943257",
  "event_id": 123,
  "kind": "run.stopped",
  "version": 1,
  "occurred_at": 1793260800000,
  "reason": "finished",
  "run_id": "run-id",
  "conversation_id": "conversation-id",
  "agent": { "id": "agent-id", "name": "opal" },
  "title": "Conversation title",
  "result_preview": "First 180 plain characters of a text result…",
  "url": "https://loop.example/?conversation=conversation-id"
}
```

| Destination run state                        | `reason`      |
| -------------------------------------------- | ------------- |
| `completed`                                  | `finished`    |
| `failed`                                     | `failed`      |
| `cancelled`, including a queued cancellation | `cancelled`   |
| `interrupted`, including native recovery     | `interrupted` |
| `paused`, from queued or pausing             | `paused`      |
| `awaiting_approval`                          | `needs_input` |

`needs_input` adds `needs: {kind: "approval" | "answer", id}` only when a durable
pending approval or native decision exists. Other reasons omit it. `project_id`
and `team_id` appear when present. Runs without an associated conversation or
agent use null for those fields and link to the Feed. Titles are plain text,
bounded to 240 characters; previews are bounded to 180 and can be empty. The
payload has no owner ID, source database identity, native session context or
credentials. The public link and display fields are captured at the transition;
retries do not rewrite the body.

Activation and **Test receiver** send control messages, not subscription event
kinds. Their schema is `{id, type: "ping", sent_at}`; timestamps in JSON are Unix
milliseconds. Both use the same durable outbox and signature headers as events.
A successful test does not repair a failed subscription; use **Retry deliveries**
to resume its event backlog.

Each POST supplies `Content-Type: application/json` and these headers:

- `X-Loop-Delivery`: the body's stable delivery `id`.
- `X-Loop-Event`: `run.stopped` or `control`.
- `X-Loop-Timestamp`: Unix seconds for this attempt.
- `X-Loop-Signature`: `v1=` followed by a hex HMAC-SHA256 of
  `<timestamp>.<raw body>`, using the displayed secret as a UTF-8 string.

Verify the raw bytes before parsing or performing an effect. This Node example
rejects stale timestamps, altered bodies and a mismatched delivery header:

```js
// webhook-verification
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(secret, rawBody, headers, now = Date.now()) {
  const timestamp = headers["x-loop-timestamp"];
  const signature = headers["x-loop-signature"];
  if (
    typeof timestamp !== "string" ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 ||
    typeof signature !== "string" ||
    !/^v1=[a-f0-9]{64}$/.test(signature)
  )
    throw new Error("Invalid webhook signature or timestamp");
  const expected = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(rawBody)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex")))
    throw new Error("Invalid webhook signature");
  const message = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  if (message.id !== headers["x-loop-delivery"])
    throw new Error("Delivery identity does not match the signed body");
  return message;
}
```

Acknowledge an accepted or already processed delivery with any 2xx status. Store
its `id` durably and deduplicate before executing your action. Delivery is at
least once: a timeout cannot establish whether the receiver accepted it. The
same body and ID are retried after 30 seconds, 60 seconds, 5 minutes, 15 minutes
and 60 minutes; the signature timestamp is generated for each attempt. A lease
prevents concurrent claims, and a reclaimed lease keeps the same delivery ID.
An uncertain send is never replaced with a new identity. Stopping the worker
before dispatch releases its claim without consuming a delivery attempt.

After the sixth unsuccessful event attempt, the subscription is `failed`.
Later stops still accumulate in its outbox, but are not sent until an explicit
retry re-arms the pending rows and resets their attempt counters. Activation
exhaustion instead leaves `pending_activation`. No event is recorded for a
subscription before activation. Revocation cancels queued work and stops
retries; an attempt already in flight can still reach the receiver. Its observed
response, or uncertain outcome, remains in history and cannot activate or
reschedule the revoked subscription.

Settings shows activation attempts, failed state, and the fifty most recent
delivery records. While a subscription remains failed, it preserves the error
and attempt count of the event that paused its backlog. Later attempts retain
their own outcomes in delivery history. Durable delivery identities
and payloads are retained; they are not deleted by change-log pruning. Web Push
subscriptions and delivery behavior are separate and unchanged.

## Cards collections and detail

```http
GET /api/v1/cards?view=results&limit=40
GET /api/v1/cards?view=saved&project=PROJECT_ID&q=chosen
GET /api/v1/cards?view=sent&agent=AGENT_ID
GET /api/v1/cards/changes?view=results&after=WATERMARK
GET /api/v1/cards/a%3AARTIFACT_ID
```

GET and HEAD share authorization and selection rules; HEAD has no body. List
responses contain `{ revision, items, next }`; changes contain
`{ revision, items, removed, more }`; detail returns a card. Each item is
`{ card, order: [number, id], saved: { at, label } | null }`. Saved relationship
data is present in Saved entries; it is not a different content variant.

| View                | Membership and order                                                                                                                                           | Supported filters                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `done`              | Session-only completed-run answers, imported answers and idle-thread fallbacks, ordered by completion time, conversation and dismissal key.                    | `project`, `agent`, `teams`      |
| `results` (default) | Visible, unarchived published results of completed runs (role `answer`, plus runless imports); no uploads or traces; a native answer joins once its done checkpoint holds content. Newest publication sequence first. | `project`, `agent`, `teams`      |
| `saved`             | Unarchived pinned artifacts, including hidden results and files, plus message bookmarks. Newest save time, then ID.                                            | `project`, `agent`, `teams`, `q` |
| `sent`              | Personally submitted user messages under the same provenance rules as [personal history](workspace.md#personal-prompt-history). Newest creation time, then ID. | `project`, `agent`, `teams`, `q` |

`teams` is a comma-separated list of at most 30 owned teams. Project filters
include descendants and the default Workspace's unfiled work. An agent filter
selects the result's agent or a personally sent message's recipient. Done preserves
Feed's conversation-agent filter and attribution, including historical runs whose
agent differs from the conversation; it does not use the Results agent contract.
Imported/runless Done answers have an unknown author: the conversation agent is
the reply target, not evidence of who wrote copied continuation messages. Assistant
and system bookmarks have no recipient agent. Saved search matches
content, result title or message conversation title, and save label. Sent search
matches prompt content. Search compares literal text after NFC normalization and
Unicode lowercase conversion (`String.toLowerCase`), with no locale-specific
collation, and accepts at most 500 characters. Unsupported parameters/combinations return 400; foreign or missing
filter objects return 404. Owner identity always comes from authentication.

`limit` is 1–100 (default 40). Pass `next` unchanged as `before` with the same
selection; null means history is exhausted. Cursors are opaque and bound to the
database, owner and normalized selection. Detail has no query parameters and
only exposes a card currently eligible for at least one supported collection.
Knowing an artifact/message ID does not grant arbitrary transcript or file access.

Done requires an owner browser/paired session; no token admission grants
Done list, changes or detail access. It returns `type: "done"` and opaque `d:`
identities, independent of published artifact identities. Its display fields carry
exact dismissal keys and existing Feed navigation and footer data. Each completed
run selects its last nonempty, non-progress assistant answer; runless imported
answers remain independent. Idle fallbacks have empty content. Continuing or
snoozing a conversation does not remove its completed answers. Explicit null
`folderId` snapshots mean Workspace; absent snapshots inherit the conversation.
Dismissal/Undo and save continue to use the existing mutation routes.
Done uses timestamp/identity window reconciliation and rejects `through` and
search. Its delta dependencies include dismissals, reminders, conversation state,
message saves, checkout/verification observations and pull-watch state, tracked by
[migration 104](../migrations/104-done-cards.sql). Its opaque watermark also tracks
clock-driven approval and stopped-pull expiry in bounded batches, so those changes
reconcile even when no database write occurs.

## Card representation

The runtime schemas and TypeScript types are in
[`src/shared/cards.ts`](../src/shared/cards.ts). A result has `type: "result"`
and an `a:` ID; a message has `type: "message"` and an `m:` ID. Treat the complete
ID as opaque. Qualify caches with the API source, authenticated owner and
selection: different sources can use the same ID.

All lists and detail return the **full stored content**, its format, attribution,
source references, conversation/project context, creation time, save state,
attachments and source-relative navigation. Common card fields are identical
across collections for the same current record. Result cards retain title, kind,
role, stored version, hidden state and explicitly selected display fields; raw metadata,
connection configuration, tool payloads and executable application resources are
not included. Body content remains the user's original stored content.

Times are Unix milliseconds. Result `updated_at` is its stored artifact timestamp;
message `updated_at` is null because messages have no generic stored modification
time. `created_at` is record creation, not completion. No completion timestamp is
invented. A synchronization watermark is not a content version.

An `owner` author means personal provenance was established. System and unknown
authors remain explicit; a recipient agent is not the message's author. Missing
agents have null descriptors. Owner profile names are not copied into cards.
`source.agent_id`, when available, identifies the source thread's agent target
for replies; it does not attribute a system or unknown message to that agent.

Attachment name, MIME type and size describe the stored attachment snapshot.
Descriptors appear only for artifacts owned by the same owner. `href` opens
Loop; nullable `download` is a protected file URL. File bytes require an owner session or a
`read` integration token. Renaming a file does not rewrite the historical
attachment description; deleting its target removes the descriptor through
synchronization.

Saving an existing result-backed message pins its result. A message bookmarked
before a result exists keeps its identity until the owner explicitly saves or
unsaves again under the existing save rules. `source.message_id` relates a result
to its message without claiming their bodies are identical. Unsave changes
membership, not the underlying content. Existing save/label mutation endpoints
continue to apply.

## Synchronization

1. Read the first page and retain its `revision` as R.
2. Follow all `next` pages, deduplicating by card ID. Keep **R from the first
   page**, even when later history pages carry newer revisions.
3. Request changes after R using the same view and filters. Upsert `items`, delete
   `removed` IDs, and store the returned revision with the selection.
4. Repeat while `more` is true, then poll from the stored revision. Advance even
   when no visible items changed.

This converges across writes during pagination; history pages are not a frozen
snapshot. Serialize history and reconciliation application so an older response
cannot replace a newer upsert. Reset on source, owner or filter changes and discard
responses belonging to a previous selection. Removals mean "no longer selected",
which includes hide, archive, move and unsave as well as deletion.

Each changes request examines at most 200 owner revisions. Multiple changes may
coalesce into current state; this is not an audit log. The watermark is captured
before rows are read so unseen later changes remain replayable. Revision history
is not pruned. Malformed, mismatched or future watermarks return **409** with a
resynchronization message: discard the selection and restart at its first page.
Invalid page cursors return 400. Server errors use `{ error: string }`.
Projection upgrades may rotate the cursor domain so unchanged historical cards
are backfilled with their current fields and eligibility. Old change watermarks
then return 409; old page cursors return 400.

Results changes optionally accept `through`, the lowest publication sequence
loaded by a UI, from `entry.order[0]`. Zero or omission covers the entire
collection, as external synchronization requires. Saved and Sent reject
`through`; their clients can reconcile the complete change batches while keeping
only their loaded timestamp/ID window. These bounds optimize a display window;
they do not grant additional access.

## Synchronization dependencies

The shared projection in [cards.ts](../src/server/cards.ts) and the triggers in
[migration 097](../migrations/097-cards.sql) and
[migration 099](../migrations/099-card-reader-display.sql) use this dependency
map. A change invalidates the affected public identity; the next read projects
its current eligible representation or a selection-relative removal.

| Mutable source                                              | Fields, membership or ordering it affects                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifacts and selected metadata                             | Body, title, format, version, role, timestamps, author/context references, visibility, model, source, file and interactive-app display capabilities |
| Messages and selected metadata                              | Body, role, personal provenance, creation order, source references and stored attachment descriptors                                                                         |
| Publication and artifact-bookmark relations                 | Results publication order, Saved membership/order and canonical save state                                                                                                   |
| Message bookmarks and saved labels                          | Saved membership, save time, labels and Saved search; old identities remain removable when a relation changes identity                                                       |
| Runs, delegations and checkpoints                           | Completion eligibility, personal provenance, recipient, `payload.folderId` project context and native checkpoint eligibility                                                 |
| Agents and conversations                                    | Names/providers, conversation title, agent/recipient, team/project filtering and ownership boundaries                                                                        |
| Recorded model connections                                  | Alias-only result model labels from the same owner's matching account/provider; catalog and ownership changes invalidate indexed dependents                                  |
| Folders and Workspace membership                            | Project names, descendant membership, folder-kind changes, subfolder moves and unfiled/default Workspace selection                                                           |
| Referenced artifacts, objects and artifact-object relations | Attachment existence/authorization and source-relative file availability; indexed reverse references identify dependent cards                                                |

User messages use the `prompt` revision entity; bookmarked non-user
messages use `message`. Changes coalesce both into one `m:` identity. Ownership
and relationship changes retain the old owner's/selection's removal as well as
the new state. Partial body chunks do not emit a body revision per chunk;
independent membership/display changes still invalidate, and terminal run states
reconcile final or retained partial content. This revision stream is separate
from stored content versions and timestamps.

## Typed readers and the example

The generated [OpenAPI document](openapi.json) uses the same Zod schemas
and route definitions as the runtime. Regenerate it with `npm run openapi`;
`npm run openapi:check` fails when the checked-in document differs. GET and HEAD,
query parameters, result/message variants, token management and authentication
alternatives are included. Session cookie names vary by deployment; an
integration bearer always uses the same header.
`IntegrationBearer` is the generated bearer security scheme.
The general OpenAPI contract requires authentication.
`PairedDevice` models the complete paired-device `Cookie` header value,
including the names issued by that deployment. Do not rename cookie prefixes or
isolated-preview suffixes. Browsers attach their existing cookie jar; non-browser
clients supply the complete header. All management writes require a matching
`Origin`. Paired writes additionally require the `PairedCsrf` header credential;
read its value from the authenticated `/session` response. Browser requests
supply `Origin` automatically.

## First-party readers

Feed Done, Agent Results, project Activity, Saved and personally sent Messages use the
versioned service and shared typed card bodies. The result reader fetches typed
detail on open; collection cards already contain full stored content and do not
fetch each off-screen item. Signed-in actions continue to use their existing
mutation endpoints. Action handlers retain the typed card and its owner/source
context; they read reply targets, saved state and display flags directly from
the card. Files and search may open real artifacts outside public card selections.
Filing and composer context use only the target fields they need. Result file links and interactive-app capability flags are
explicit display fields; the app's private tool payload is fetched only when a
signed-in reader opens the interactive app, outside the Cards API.
`refreshable` requires a complete stored agent/tool/connection/arguments source.
It is not a permission grant; refresh rechecks current owner and tool access.
Every result includes explicit nullable display values and capability booleans,
and every card identifies its source agent or explicitly reports null.
Model labels prefer the recorded execution identity. Historical aliases resolve
only through their recorded, same-owner connection and matching provider; absent
catalogs keep the stored alias. The public display field contains the label,
without exposing the account's configuration or credentials.

UI pagination uses a bounded window. Results changes pass the lowest loaded
publication sequence as `through`; Saved and Sent apply their `(time, id)`
ordering boundary locally. A refresh updates existing and newer visible cards,
advances past irrelevant revisions and retains older loaded pages. Requests are
serialized and coalesced; a source/owner/filter change invalidates pending
responses. Committed windows and Saved searches are retained in the bounded
in-memory view cache for their owner, source and selection. Returning to a tab
restores that window and reconciles changes; logout/account changes clear it.
Full-collection integrations omit `through` and paginate the HTTP results. A still-eligible card below `through` is not a removal.

The Files tab retains `/api/results?view=files` and its card renderer adapter.
Remaining `/api/results`, `/api/results/updates`, `/api/saved`, `/api/me/prompts`
and artifact-reader callers retain their wire contracts. Shared production
eligibility/provenance predicates still govern those reads; the
new first-party content collections do not interpret their raw rows. The
operational Feed summaries and Needs you/Working/Queued actions keep their own
identity and behavior. Done uses the typed Cards reader and a bounded per-source
pager; it retains loaded windows and reconciles further 200-revision batches in
scheduled refreshes. Opening a Done answer uses its full card body without a
per-message fetch. Failed Cards reads surface a source error and retain its loaded
window and paging cursor. A 409 revision reset resynchronizes within the Cards
contract; reads do not switch to the operational Feed endpoint. Dismissal/Undo and save update the
source-bound visible and pager caches together.
