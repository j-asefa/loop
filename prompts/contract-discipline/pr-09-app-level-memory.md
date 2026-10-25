# PR 9: application-level routes and memory

Depends on PR 8. The `app` registrar from PR 1 (`/api/capabilities`, `/api/health`, `/api/build`, `/api/diagnostic`, `/api/events`, the `/api/mcp/*` family) and `memoryRoutes` (9).

## Routes

App: `GET /capabilities`, `GET /health`, `GET /build`, `POST /diagnostic`, `GET /events`, `ALL /mcp/federation`, `ALL /mcp/reverse`, `POST /mcp/federation/enroll`, `POST /mcp/federation/import`, `POST /mcp/federation/import-reverse`, `POST /mcp/federation/revoke`, `GET /mcp/federation/pending`, `POST /mcp/federation/claim/:id`, `POST /mcp/federation/complete/:id`. Memory: `GET /conversations/:id/memory`, `GET /memory`, `PUT /memory/policy`, `GET|DELETE /memory/sources/:id`, `POST /memory/notes`, `PATCH /memory/notes/:id`, `GET /memory/notes/:id/versions`, `GET /runs/:id/memory`.

## Rules specific to this PR

- `GET /capabilities` returns the `Capabilities` interface from `src/shared/capabilities.ts`; convert that interface to a zod schema and infer the type from it so there is one definition.
- `GET /events` is the HTTP polling fallback for the event stream. Its response is a page of `WorkspaceEvent` values and a cursor; `workspace-events.ts` already has the schemas. PR 10 registers the socket frames; this PR types only the HTTP page.
- `ALL /mcp/federation` and `ALL /mcp/reverse` are JSON-RPC transports with their own 12 MB body limit and their own token authentication. `RouteContract` has no `ALL`. Add `method: "ALL"` with `kind: "transport"`: the registrar mounts the handler without input or output validation and the generator emits the operation with a documented opaque body. These two stay out of the response-validation path; say so in the PR body and in `contracts.md`.
- The remaining federation routes are paired-device management calls with request identities; type them exactly.
- Memory notes have versions and an outbox (`docs/architecture.md`, "Memory, tools and files"). Responses are display projections; recall content is untrusted historical evidence and the schema does not change that.

## Client, tests, acceptance

Move call sites. Full baseline, `openapi:check`, `smoke:feed-events` (HTTP fallback path with sockets blocked). The `app` registrar and `memoryRoutes` register nothing through `legacy`. After this PR the server legacy list is empty; record it.
