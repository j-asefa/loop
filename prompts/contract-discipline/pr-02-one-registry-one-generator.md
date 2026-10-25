# PR 2: one registry, one generator

Depends on PR 1.

## Goal

The Cards API registry (`src/shared/card-api.ts`, six entries) and the workspace registry (`src/shared/workspace-api.ts`) become one `RouteContract` registry, and one generator emits one OpenAPI document that grows as routers are typed. The hand-maintained parts of the Cards document disappear. `npm run openapi:check` becomes the check every later PR runs.

## Registry

1. Extend `RouteContract` in `workspace-api.ts` with `method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"`, optional `status` (default 200) and `access: "session" | "card:results" | "card:cards"`. Existing entries get `access: "session"`. Update `route()`/the registrar to send `status` when set.
2. Move the six `cardApi` entries into `workspaceApi` under keys `cardList`, `cardChanges`, `cardDetail`, `cardTokens`, `cardTokenCreate`, `cardTokenRevoke`. Convert their shapes: `id` becomes `params: z.object({ id })`, `query`/`body` default to `Empty`/`NoBody` where absent. The card reads keep `access: "card:results"` or `"card:cards"` as their current grant table in `docs/cards-api.md` states; the token routes are `"session"`. Paths do not change.
3. Register the six through `on(...)` in `card-routes.ts` and `card-token-routes.ts`; delete their legacy keys. The `cards.use("/v1/cards", …)` admission middleware stays as it is, and `cardReadRoute` in `src/shared/card-access.ts` now derives its method/path matching from the three card-read contracts instead of its literal strings. Add a test that the derived predicate accepts and rejects exactly what the literal version did, including HEAD, query strings and the detail id pattern.
4. Delete `card-api.ts` once nothing imports it. `CardErrorSchema` and `CreatedCardTokenSchema` move to `workspace-api.ts` or `card-access.ts`.

## Generator

1. Rename `scripts/cards-openapi.mjs` to `scripts/openapi.mjs`. It reads `workspaceApi`, registers every contract's `params`, `query`, `body` and `response` in a zod registry, and emits `docs/openapi.json` with one operation per contract: `operationId` is the registry key, path parameters from `params`, query parameters from `query` with `required` derived from the input schema, request body from `body` where not `NoBody`, the success status from `status`, and the error statuses the current Cards generator emits. Preserve the current Cards operations' output exactly except for the file they live in; diff the two documents in the PR body.
2. Keep the `Origin` header parameter on writes and the `Retry-After` header on 429 as today.
3. `security` on each operation reflects `access`: `session` operations list the browser session; `card:*` operations list the bearer token with the grant. Keep the existing component names so `docs/cards-api.md` stays accurate.
4. `docs/architecture.md` line 38 says the workspace contracts are separate from the Cards OpenAPI document; after this PR that is false. Replace it with one sentence pointing at the single registry and generated document.
5. `package.json`: `"openapi": "node --import tsx scripts/openapi.mjs"`, `"openapi:check": "npm run openapi -- --check"`. Remove `cards:openapi` and `cards:check`; update every reference in `docs/development.md`, `docs/cards-api.md`, this bundle's `verification.md` and the reactive bundle's ledger if it still mentions them (do not edit the reactive bundle's spec files otherwise).
6. `test/card-client.test.ts` reads `docs/openapi.json`. Delete `docs/cards-openapi.json`.

## Tests

- The generator's output for the six Cards operations is byte-identical in content to the previous document (test by generating both at the parent commit and the branch head and diffing the Cards paths and components in the PR body).
- `openapi:check` fails when a contract changes without regenerating (`--check` behaviour unchanged).
- Full baseline, `smoke:cards`, `test/card-client.test.ts`, every `test/card-access*.test.ts`.

## Acceptance

One registry, one generator, one document, one check script. `card-api.ts` and `cards-openapi.json` are gone. Card token permissions, selection rules, cursors and rate limits are unchanged, proven by the existing Cards tests and smoke.
