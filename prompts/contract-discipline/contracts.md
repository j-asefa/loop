# Contract rules

Every contract in this bundle follows these rules. They extend `src/shared/workspace-api.ts` as PR 11b left it; read that file's existing contracts first and match their style.

## Shape

- A contract is `{ method, path, params, query, body, response, status?, access }`. Ordinary `method` values are GET, POST, PUT, PATCH, DELETE; delegated transports may use ALL as described below. `path` is relative to the `/api` mount and uses Express `:param` syntax. `status` defaults to 200. `additionalStatuses` lists other statuses using the same declared response shape (for example 200 on a scheduled-send replay versus 201 on creation, or health's structured 503 readiness response); it adds them to OpenAPI without changing the handler. `access` is `"session"` for every route in this bundle except the Cards reads, which keep their existing `"card:results"` / `"card:cards"` grants (PR 2). Integration-token scopes are a later bundle; do not invent them here.
- File responses use `kind: "stream"` and a `z.custom<Blob>()` response marker. The registrar still validates params/query/body but leaves the response writer untouched, including attachment JSON. Typed browser helpers return the response as a Blob; `routeUrl` builds validated browser file addresses and stream-only `fetchStream` preserves headers for the existing preview reader. Optional `contentType` describes a fixed media type in OpenAPI; otherwise the document uses application/octet-stream.
- Protocol transports declare `kind: "transport"`, a `protocol` of `mcp` or `authentication`, and `method: "ALL"` (or a concrete POST for an existing browser auth operation). Their protocol owners retain raw requests, validation, errors, cookies, redirects and streaming, so the registrar does not validate or project them. MCP retains its own 12 MB parser and service-token authentication. OpenAPI documents opaque responses, actual protocol security and `x-loop-method: ALL`; browser helpers reject ALL dispatch. The separate GET `/auth/get-session` is an ordinary typed projection: it keeps Better Auth's cookie renewal and error handling while removing internal session and account fields from successful JSON. Optional `security` metadata documents existing public, optional-session, local-setup or paired-device middleware; it never authorizes a request. Paired-host routes remain behind the host’s paired cookie and write Origin/CSRF checks; their native HTTP dispatch table consumes the same registry and is included in the route inventory.
- Multipart requests declare `multipart: true`. Their body schema describes text fields; typed inputs also require a Blob `file` and accept an optional `filename`. The registrar receives the existing Multer file after its unchanged limits. OpenAPI describes the file as binary in multipart/form-data. Query arrays serialize as repeated keys.
- One registry, `workspaceApi`, keyed by a stable camelCase name that becomes the OpenAPI `operationId`. Names never change once merged. Group related routes by prefix in the key (`agentCreate`, `agentUpdate`), not by nesting.
- `params`, `query` and `body` are strict where the route is strict today and lenient where it is lenient today. Do not tighten input on an existing route unless the current handler already rejects that input; record each tightening you did make in the PR body as a compatibility decision.
- GET routes have `body: NoBody`. Routes that return nothing today return `Ok` or an explicit empty object; do not invent response fields.

## Responses are projections

- Response schemas describe what the browser receives, never a storage row. Never import `row-schemas.ts`, `query-records.ts`, `db.ts` or any credential schema into `src/shared`. The existing `Public*` schemas are the pattern: add to them, extend them, or add a sibling.
- Unknown fields are removed by the schema. This is the mechanism that keeps an accidental column out of the browser. If the current handler emits a field the schema does not declare, decide: declare it (it is public today) or drop it (it should not have been public). Record every drop in the PR body; a dropped field that the client reads is a behaviour change and must instead be declared.
- Opaque JSON columns the browser parses itself (`payload`, `metadata`, `models`, `preset_config`, `request`) stay `Text`. Do not parse or re-validate stored JSON at the HTTP boundary; PR 11a owns row validation.
- Fields that older linked sources omit are `.optional()` with a comment naming why, as the existing `Bootstrap` and `PublicConversation` do. Absence must never grant a capability or synthesize authority. A present malformed value is rejected.

## Failure

- Invalid input is a `Problem` 400 through the existing error middleware; `route()` already does this. Do not catch and reshape.
- Invalid output is the existing generic 500 from `route()`. Never surface the schema issue to the browser.
- A route whose current handler returns different shapes on different branches gets a `z.union` or a discriminated union, not a loosened schema. If the branches cannot be unified without a behaviour change, record it under "Found, not fixed".

## Client

- When a route is typed, every browser call to it moves to `callRoute`/`readRoute` with the contract, and the call site's local type annotations and `any` defaults are removed. Clients never build the path by hand.
- GET reads keep their existing cancellation and bounded recovery through `readRoute`. Mutations go through `callRoute` and are never retried by the helper.
- The client legacy helper (PR 1) only accepts paths named in `src/client/legacy-paths.ts`. Delete a path's entry in the same PR that types its route.

## Evidence

Each typed route has one actual-HTTP test as [verification](verification.md) specifies. Response fixtures come from rows created through production write paths in the test, never from literal objects, so the schema is checked against what the server really emits.
