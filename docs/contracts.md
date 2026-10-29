# Contract rules

Every workspace, Cards and fleet API route is declared as a contract; the host's pairing, bootstrap and static handlers sit outside this contract boundary (the workspace `bootstrap` route is itself a contract). Workspace and Cards routes live in the [workspace registry](../src/shared/workspace-api.ts) and are mounted on the server through the [registrar](../src/server/registrar.ts); the paired host dispatches a small set of the same workspace contracts through its own contract table in [host.ts](../src/host.ts) without Express. Fleet routes live in their own registries (`fleetAdminApi`, `fleetPeerApi`, `fleetDirectoryApi`, `fleetHandoffApi`, `fleetPendingDirectoryApi`, `fleetCredentialApi` under `src/shared/fleet-*-api.ts`) with their own generators. There is no untyped registration path on any of them. These rules govern every contract added or changed. Read the existing contracts first and match their style. [Architecture](architecture.md#workspace-http-contracts) describes how the registrar, generator and browser helpers behave at runtime; this page says what a contract must look like.

## Shape

- A contract is `{ method, path, params, query, body, response, status?, additionalStatuses?, security?, access, identity? }` plus a kind. Ordinary routes use GET, POST, PUT, PATCH or DELETE and may set `kind: "stream"`. Transports set `kind: "transport"`, must set `protocol` (`"mcp"` or `"authentication"`), and use POST or `ALL`; `ALL` exists only for transports. `path` is relative to the `/api` mount and uses Express `:param` syntax. `status` defaults to 200; `additionalStatuses` lists other statuses the handler already writes with the same response shape (a 200 replay beside a 201 creation, health's 503 beside its 200) and documents them without changing the handler.
- `security` documents the authentication boundary (`public`, `local-setup`, `optional-session`, `paired-device`, `integration-token`) for the generated document. It never authorizes or bypasses anything. Token-only event handlers explicitly require the bearer identity; a session cannot create a token checkpoint. The token WebSocket upgrade uses the same mounted route's admission as HTTP, with separate origin checks at each listener. Its client acknowledgement schema belongs to the channel registry; ordinary HTTP GET/HEAD returns 426 without opening a socket.
- `access` names who may reach the route: `"session"` for browser and paired-device callers; `{ admits: readonly TokenAdmission[] }` for sessions plus tokens whose stored admission values intersect that list; `peer:enrollment`, `peer:handoff` and `peer:directory` for dedicated peer HTTP between Loop hosts; `peer:credentials` for destination-issued, operation-scoped machine challenges and credential proofs under the enrolled grant; `device:fleet` for local paired-device fleet administration. Transports never accept `{ admits }`. Peer and fleet registries retain string-only access and never admit integration bearers. The mounted contract supplies both server and paired-host bearer admission; do not introduce a separate route allowlist. A new access kind is introduced only by the change that also implements its admission and documents it on this page; never declare an access kind the admission middleware does not enforce. Credential routes use the dedicated peer HTTP admission, reject browser credentials, and issue access only after verifying the enrolled machine's signed challenge response and current grant.
- A mutating contract admitting `write` or `approvals:decide` must declare `identity`, the validated body field used for replay. The type rejects its omission. Register it with a contract-specific `tokenWrite` policy: local effects and completion commit together; external effects start only after pending commits. The registrar buffers the projected response until that commit and re-projects completed locators without invoking the handler. See [Integration API replay rules](cards-api.md#write-identities-and-replay). Session callers retain the original optional-field behavior.
- File responses use `kind: "stream"` and a `z.custom<Blob>()` response marker. The registrar still validates params/query/body but leaves the response writer untouched, including attachment JSON. Typed browser helpers return the response as a Blob; `routeUrl` builds validated browser file addresses and stream-only `fetchStream` preserves headers for the existing preview reader. Optional `contentType` describes a fixed media type in OpenAPI; otherwise the document uses application/octet-stream.
- Transports own validation, errors, cookies, redirects and streaming; the registrar passes raw requests through.
- Multipart requests declare `multipart: true`. Their body schema describes text fields; typed inputs also require a Blob `file` and accept an optional `filename`. The registrar receives the existing Multer file after its unchanged limits. OpenAPI describes the file as binary in multipart/form-data. Query arrays serialize as repeated keys.
- Registry keys are stable camelCase names that become OpenAPI `operationId`s. Names never change once merged. Group related routes by prefix in the key (`agentCreate`, `agentUpdate`), not by nesting.
- `params`, `query` and `body` are strict where the route is strict today and lenient where it is lenient today. Do not tighten input on an existing route unless the current handler already rejects that input; record each tightening you did make in the PR body as a compatibility decision.
- GET routes have `body: NoBody`. Routes that return nothing return `Ok` or an explicit empty object; do not invent response fields.

Workspace federation adds the `fleetWorkspaceApi` and `fleetWorkspaceActionApi`
registries under `src/shared/fleet-*-api.ts`. Their `peer:workspace` access uses
machine admission and destination-issued `read` or `act` credentials. The grant
maps to the destination owner; browser credentials, arbitrary paths and private
native/provider routes are refused. Catalog and allowlisted reads use the
existing workspace contracts' projections. Durable actions and receipt reads
preserve the originating machine, original command and current grant through
destination receipts and generation checks.

## Responses are projections

- Response schemas describe what the caller receives, never a storage row. Never import `row-schemas.ts`, `query-records.ts`, `db.ts` or any credential schema into `src/shared`. The existing `Public*` schemas are the pattern: add to them, extend them, or add a sibling.
- Unknown fields are removed by the schema. This is the mechanism that keeps an accidental column out of the browser. If a handler emits a field the schema does not declare, decide: declare it (it is public) or drop it (it should not have been public). Record every drop in the PR body; a dropped field that a client reads is a behaviour change and must instead be declared.
- Opaque JSON columns the browser parses itself (`payload`, `metadata`, `models`, `preset_config`, `request`) stay `Text`. Do not parse or re-validate stored JSON at the HTTP boundary; row validation belongs to the [saved-row readers](architecture.md#saved-rows).
- Fields that older linked sources omit are `.optional()` with a comment naming why, as the existing `Bootstrap` and `PublicConversation` do. Absence must never grant a capability or synthesize authority. A present malformed value is rejected.

## Failure

- Invalid input is a `Problem` 400 through the existing error middleware; the registrar already does this. Do not catch and reshape.
- Invalid output is the registrar's generic 500. Never surface the schema issue to the caller.
- A route whose handler returns different shapes on different branches gets a `z.union` or a discriminated union, not a loosened schema. If the branches cannot be unified without a behaviour change, record the defect in the PR and leave the behaviour alone.

## Client

- Every browser call goes through `callRoute`/`readRoute` (or `routeUrl`/`fetchStream` for files) with the contract, with no local type annotations or `any` defaults at the call site. Clients never build an `/api` path by hand; the exported transport helpers accept only contracts.
- GET reads keep their existing cancellation and bounded recovery through `readRoute`. Mutations go through `callRoute` and are never retried by the helper.

## Evidence

Each route has one actual-HTTP test at its owning production entrypoint on an isolated database: the server `app` from `src/server/index.ts` for workspace routes, as [workspace-route-contracts.test.ts](../test/workspace-route-contracts.test.ts) does; the paired host for host-dispatched contracts; the fleet entrypoints for fleet registries. Response fixtures come from rows created through production write paths in the test, never from literal objects, so the schema is checked against what the server really emits. `npm run check` runs every `test/*-contracts.test.ts` and `openapi:check`; see [Development](development.md).
