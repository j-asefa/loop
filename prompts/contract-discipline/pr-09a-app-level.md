# PR 9a: application-level routes and authentication transports

Depends on PR 8b. The `app` registrars in `src/server/index.ts` (five private registrars mounted at the original authorization boundaries, per the PR 1 decision). Seventeen entries.

## Routes

Typed contracts: `GET /capabilities`, `GET /health`, `GET /build`, `POST /diagnostic`, `GET /events`, `GET /auth-options`, `GET /auth/get-session`, `GET /mcp/federation/pending`, `POST /mcp/federation/enroll`, `POST /mcp/federation/import`, `POST /mcp/federation/import-reverse`, `POST /mcp/federation/revoke`, `POST /mcp/federation/claim/:id`, `POST /mcp/federation/complete/:id`.

Transports: `ALL /auth/*splat` (Better Auth's handler), `ALL /mcp/federation` and `ALL /mcp/reverse` (JSON-RPC with their own 12 MB limit and token authentication).

## Rules specific to this PR

- Add `method: "ALL"` with `kind: "transport"` to `RouteContract`. The registrar mounts a transport without input or output validation; the generator emits the operation with a documented opaque body and the security scheme the transport actually checks. Record in `contracts.md`'s Shape section that transports stay outside response validation and why.
- `GET /capabilities` returns the `Capabilities` interface from `src/shared/capabilities.ts`. Convert that interface to a zod schema and infer the type from it so there is one definition. The design-preview override of `cardTokens` stays in the handler.
- `GET /events` is the HTTP polling fallback for the event stream. Production-code correction: it returns an array of owner-scoped event rows, with serialized `payload` text and row IDs used as cursors, not a V3 page object. Preserve that wire shape and the existing client normalization. PR 10 registers the socket frames.
- `GET /auth/get-session` is the session read the client does before anything else, including the raw `fetch` the PR 1 ledger deferred. Type its credential-free display projection: the current shell reads `user.id`, `user.name` and an optional deployment `mode`. Paired CSRF comes from the host's separate session endpoint, and handles come from the profile API; do not invent them here. Remove Better Auth's internal session row and unused account fields from successful JSON while preserving its cookie renewal and protocol errors. The existing sign-in/sign-up/social/sign-out POST paths may have explicit protocol declarations for typed browser callers ahead of the ALL catchall.
- Federation management is local single-user source-adapter setup, not paired-browser management. Preserve the local authority and `x-loop-source-setup: 1` guard before contract validation. Enrollment intentionally issues a service token only behind that boundary; paired proxies cannot forward the setup header. Preserve existing request identities, coercions and authorization ordering.

## Client, tests, acceptance

Move call sites, including the deferred session read if 12b3 has merged. `npm run check`, full baseline, `smoke:feed-events` (HTTP fallback with sockets blocked), `smoke:companion`. The `app` registrars register nothing through `legacy`.

## Delivery split required by review capture

The full application/auth migration produced a318,129-byte branch diff, beyond the300,000-byte capture bound even after bringing the generated document below512,000 bytes. Land9a1 first with this bundle amendment and shared OpenAPI error response definitions, preserving expanded operations and exact Cards objects. Then9a2 lands every route, caller and regression above; the parent acceptance is not complete until9a2 merges. The preserved complete draft is27b0d37a on contracts/wip-app-before-capture-split. Each split runs its baseline and obtains complete review coverage.9a1's changed boundary is generated-document reference resolution;9a2 runs the application/auth HTTP, protocol and browser gates.
