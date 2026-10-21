# Cards API

The versioned card service exposes individual results, saved items and personally
sent prompts. Conversation Feed summaries, Status and Briefs remain separate.
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

Results changes optionally accept `through`, the lowest publication sequence
loaded by a UI, from `entry.order[0]`. Zero or omission covers the entire
collection, as external synchronization requires. Saved and Sent reject
`through`; their clients can reconcile the complete change batches while keeping
only their loaded timestamp/ID window. These bounds optimize a display window;
they do not grant additional access.
