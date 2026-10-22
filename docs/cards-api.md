# Cards API

The versioned card service exposes individual results, saved items and personally
sent prompts. The session-only `done` collection preserves independent completed answers and idle-thread fallbacks. Conversation Feed summaries remain separate.
The Files tab continues to use `/api/results?view=files`.

Use an authenticated Loop browser/paired-device session, or a local integration
token in `Authorization: Bearer …`. Reads do not save, acknowledge, mark read,
resolve decisions or dispatch work.

## Integration tokens

Open **Settings → Card API tokens**, name the token and choose its read access.
Copy the secret when it appears; Loop only stores its SHA-256 digest and cannot
display it again. Keep it in a script's environment or secret store. The same
Settings page lists nonsecret metadata and revokes tokens immediately.

| Scope          | Access                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| `results:read` | Eligible visible published Results, their details and changes                          |
| `cards:read`   | Results, Saved (including messages and files), Sent prompts and their eligible details |

Both grants cover the owner's projects. Query filters narrow a selection, not
the grant. A token belongs to one source and owner; it cannot reach linked
sources or proxy requests. Changing a single-user installation's selected owner
invalidates the previous owner's tokens for that installation. Broader future
collections require an explicit grant change.

An Authorization header selects token authentication before any browser cookie.
Malformed schemes (including Basic), invalid/revoked tokens and insufficient
grants never inherit the session's permissions. Gateways must consume their own
Authorization credentials before forwarding browser traffic. The integration
exception admits only the implemented card GET/HEAD routes. Other API paths,
methods, source proxies, file downloads and token management are unavailable to
card credentials. Ordinary paired sessions retain their origin/CSRF rules.
No third-party browser CORS or OAuth flow is provided.

Owner sessions manage tokens with `GET /api/card-tokens`,
`POST /api/card-tokens` (`{ request_id, secret, name, scope }`) and
`DELETE /api/card-tokens/:id`. Creation returns `{ token, secret }`; list returns
only token metadata. At most 50 tokens may be active; recent revoked metadata is
retained in a bounded history. Nonsecret creation identities and secret digests
are retained to prevent reviving a pruned revoked credential, including under a
new creation identity. Secrets are never put in URLs or browser storage. The Settings client generates a
32-byte random secret and a UUID creation identity before sending the request.
Retrying the exact request returns the same token; changing its fields or retrying
a revoked identity returns 409. `cardTokenRequest(name, scope)` supplies this
request shape for session-authenticated tools. Keep the creation receipt only
in memory. If a response is lost, Settings reconciles the metadata list and can
finish the same creation; closing and reopening Settings retains a pending
receipt for that owner/source. Reloading the page discards secrets: revoke any
uncopied token using the metadata list and create another.

Requests are limited to 120 per token and 600 per owner per minute. A 429 response
includes `Retry-After: 60`. The approximate `last_used_at` updates at most once a
minute; each request still checks revocation. These bookkeeping tables are the
only state changed by token reads, along with source/owner-bound identifiers of
cards previously returned to that token. Removal responses expose only those
previously disclosed IDs; they never reveal IDs of private uploads or other
ineligible records. This read bookkeeping is discarded on revocation. After
changing credentials, backfill the selection again before consuming changes;
revision reuse across different tokens is not a substitute for that backfill.
GET and HEAD have identical permissions.

Read-disclosure storage grows with distinct cards returned per active token;
repeated reads do not add duplicate rows. Keep only the integration tokens you
need and revoke unused ones. These short, indexed bookkeeping writes share the
database write lock with the worker; the rate limits bound their frequency.

## Collections and detail

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
| `done` | Session-only completed-run answers, imported answers and idle-thread fallbacks, ordered by completion time, conversation and dismissal key. | `project`, `agent`, `teams` |
| `results` (default) | Visible, unarchived published results of completed runs; no partials, uploads or traces. Newest publication sequence first.                                    | `project`, `agent`, `teams`      |
| `saved`             | Unarchived pinned artifacts, including hidden results and files, plus message bookmarks. Newest save time, then ID.                                            | `project`, `agent`, `teams`, `q` |
| `sent`              | Personally submitted user messages under the same provenance rules as [personal history](workspace.md#personal-prompt-history). Newest creation time, then ID. | `project`, `agent`, `teams`, `q` |

`teams` is a comma-separated list of at most 30 owned teams. Project filters
include descendants and the default Workspace's unfiled work. An agent filter
selects the result's agent or a personally sent message's recipient; assistant
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

Done requires an owner browser/paired session; neither existing token scope grants
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
stored version, hidden state and explicitly selected display fields; raw metadata,
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
Loop; nullable `download` is an existing session-protected file URL. Descriptors
do not grant access to file bytes. Renaming a file does not rewrite the historical
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

| Mutable source | Fields, membership or ordering it affects |
| --- | --- |
| Artifacts and selected metadata | Body, title, format, version, timestamps, author/context references, visibility, snippet/upload/partial status, model, source, file and interactive-app display capabilities |
| Messages and selected metadata | Body, role, personal provenance, creation order, source references and stored attachment descriptors |
| Publication and artifact-bookmark relations | Results publication order, Saved membership/order and canonical save state |
| Message bookmarks and saved labels | Saved membership, save time, labels and Saved search; old identities remain removable when a relation changes identity |
| Runs, delegations and checkpoints | Completion eligibility, personal provenance, recipient, `payload.folderId` project context and native checkpoint eligibility |
| Agents and conversations | Names/providers, conversation title, agent/recipient, team/project filtering and ownership boundaries |
| Recorded model connections | Alias-only result model labels from the same owner's matching account/provider; catalog and ownership changes invalidate indexed dependents |
| Folders and Workspace membership | Project names, descendant membership, folder-kind changes, subfolder moves and unfiled/default Workspace selection |
| Referenced artifacts, objects and artifact-object relations | Attachment existence/authorization and source-relative file availability; indexed reverse references identify dependent cards |

User messages retain the legacy `prompt` revision entity; bookmarked non-user
messages use `message`. Changes coalesce both into one `m:` identity. Ownership
and relationship changes retain the old owner's/selection's removal as well as
the new state. Partial body chunks do not emit a body revision per chunk;
independent membership/display changes still invalidate, and terminal run states
reconcile final or retained partial content. This revision stream is separate
from stored content versions and timestamps.

## Typed readers and the example

The generated [OpenAPI document](cards-openapi.json) uses the same Zod schemas
and route definitions as the runtime. Regenerate it with `npm run cards:openapi`;
`npm run cards:check` fails when the checked-in document differs. GET and HEAD,
query parameters, result/message variants, token management and authentication
alternatives are included. The session cookies and trusted standalone access
boundary vary by deployment; a Cards bearer token always uses the same header.
The general OpenAPI contract requires authentication. A trusted single-user
standalone installation can additionally rely on its configured access boundary;
this deployment exception is not declared as globally optional authentication.
`OwnerSession` and `PairedDevice` model the complete `Cookie` header value,
including the names issued by that deployment. Do not rename cookie prefixes or
isolated-preview suffixes. Browsers attach their existing cookie jar; non-browser
clients supply the complete header. All management writes require a matching
`Origin`. Paired writes additionally require the `PairedCsrf` header credential;
read its value from the authenticated `/session` response. Browser requests
supply `Origin` automatically.

`src/shared/card-client.ts` provides `createCardClient({ baseUrl, token })` for
integrations and `cardReader(transport)` for source-bound browser sessions.
Responses are validated against the shared schemas. Tokens are sent only in the
Authorization header; the integration client refuses redirects and does not
send browser cookies. Its base URL is one workspace origin, without a path,
credentials, query or fragment. Remote origins require HTTPS before any request
is sent; HTTP is accepted only for `localhost`, `127.0.0.1` and `[::1]` fixtures
or local development. The same URLs work with a standalone server or
a paired-host companion; no device cookie is needed for the scoped bearer path.

Run the full-collection example from this checkout:

```sh
export CARDS_BASE_URL='https://your-workspace.example'
# Set CARDS_TOKEN from your secret store; never commit the value.
npm run cards:example
```

Optional environment variables are `CARDS_VIEW` (default `results`),
`CARDS_PROJECT`, `CARDS_AGENT`, `CARDS_TEAMS` and `CARDS_QUERY`. Search requires
`CARDS_VIEW=saved` or `CARDS_VIEW=sent`; Results does not support `CARDS_QUERY`.
The example and `CardCollection` omit empty or whitespace-only queries. The script
paginates the complete selection, keeps the first watermark, then drains all
changes and removals before grouping cards by project. Output IDs are qualified
by source. `CardCollection.sync()` can be called again to reconcile subsequent
changes without another backfill. It returns deeply frozen, readonly snapshots;
copy data before making local edits so consumers cannot alter the cached server
state or each other's concurrent result. The collection copies incoming entries
before freezing its own snapshot; a custom reader's objects remain untouched.
For a grouped aggregate, importing
`syncExample(environment)` from the example returns an async read function;
call that function again to reconcile the same collection and regroup it.
Create a new collection when the owner,
source, credential or selection changes; discard previous results and abort
pending reads. A 409 clears the collection and requires a fresh sync. A 404 for
a deleted filter means the selection itself must change; retrying it unchanged
does not restore that object. Credential failures are surfaced immediately.
On 429 with a positive `Retry-After`, collection synchronization waits and retries
that read, retaining its unpublished pages and watermark. Large backfills and
change backlogs can cross multiple rate windows without restarting. Abort the
supplied signal to cancel a wait. Concurrent calls share a sync only when they
use the same signal (or all omit it); a different signal is rejected, so one
caller's cancellation cannot be silently ignored or control another caller.
Other failures, including 429 without a retry
delay, are surfaced. The lower-level client reports errors without retrying.

## First-party readers and compatibility

Feed Done, Agent Results, project Activity, Saved and personally sent Messages use the
versioned service and shared typed card bodies. The result reader fetches typed
detail on open; collection cards already contain full stored content and do not
fetch each off-screen item. Signed-in actions continue to use their existing
mutation endpoints. Result file links and interactive-app capability flags are
explicit display fields; the app's private tool payload is fetched only when a
signed-in reader opens the interactive app, outside the Cards API.
`refreshable` requires a complete stored agent/tool/connection/arguments source.
It is not a permission grant; refresh rechecks current owner and tool access.
Readers accept the initial v1 result shape from an older linked source: absent
display additions default to unknown values or unadvertised capabilities, without
inventing file links or application permissions. Sources predating `/api/v1/cards`
must be updated to use these views. Update a v1 source to obtain the richer file
and application display fields; its ordinary content remains readable meanwhile.
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
Full-collection integrations omit `through` and use `CardCollection` as described
above. A still-eligible card below `through` is not a removal.

The Files tab retains `/api/results?view=files` and its legacy renderer adapter.
Remaining `/api/results`, `/api/results/updates`, `/api/saved`, `/api/me/prompts`
and artifact-reader callers retain their wire contracts. Shared production
eligibility/provenance predicates still govern those compatibility reads; the
new first-party content collections do not interpret their raw rows. The
operational Feed summaries and Needs you/Working/Queued actions keep their own
identity and behavior. Done uses the typed Cards reader and a bounded per-source
pager; it retains loaded windows and reconciles further 200-revision batches in
scheduled refreshes. Opening a Done answer uses its full card body without a
per-message fetch. Sources that reject the Done view retain expanded legacy Feed
reads, and refresh rechecks capabilities after a source upgrade or replacement.
Contract transitions retain loaded history while the new pager catches up; opaque
cursors are never sent to the other endpoint. Dismissal/Undo and save update the
source-bound visible and pager caches together.
