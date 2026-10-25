# PR 5: folders, artifacts, search, preferences, imports

Depends on PR 4. Router: `workspace` in `src/server/workspace-routes.ts`, 23 routes.

## Routes

`GET|POST /folders`, `PATCH /folders/:id`, `GET /artifacts`, `GET /artifacts/:id`, `POST /artifacts`, `PATCH /artifacts/:id`, `POST /artifacts/:id/move`, `GET /runs/:id/checkout`, `GET /runs/:id/verifications`, `GET /runs/:id/files`, `POST /operations/:id/undo`, `GET /objects/:id`, `GET /search`, `GET /search/status`, `GET|POST /preferences`, `POST /imports/preview`, `GET /imports`, `POST /imports/:id/start`, `POST /imports/:id/cancel`, `POST /conversations/:id/continue`.

## Rules specific to this PR

- `PublicArtifact` and `PublicFolder` exist. Artifact `content` is public artifact content; `metadata` stays `Text`.
- `GET /objects/:id` returns a polymorphic object today. Use a discriminated union over the kinds the handler actually returns; list them in the PR body. If a kind cannot be declared without changing behaviour, record it under "Found, not fixed" and declare the union over the kinds that can.
- Search responses include excerpts from `search-excerpt.ts`; type the excerpt shape there and import it.
- Preferences are an owner-private key/value projection. Declare the keys the client reads; unknown keys are removed by the schema and listed in the PR body. If the client reads keys dynamically, declare `z.record` with a bounded key schema instead.
- Imports carry cancellation (`POST /imports/:id/cancel`) and PR 11a3a5 already validated their rows; the HTTP schemas sit above that and do not re-parse.

## Client, tests, acceptance

As PR 4, plus `smoke:workspace` and `smoke:history` (search and file views). `workspace-routes.ts` registers nothing through `legacy`.
