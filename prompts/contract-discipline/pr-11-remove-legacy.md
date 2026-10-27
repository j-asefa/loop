# PR 11: remove the legacy path

Depends on PR 10, on both legacy lists being empty apart from the deferred protected-file entries, and on reactive 12b3 (#211) having merged. The ledger's "Deferred to after reactive 12b" table is long (artifact reads, result hide, profile, scheduled sends, routing and share previews, the three Cards readers, the raw session read); this PR finishes every row, deletes the client patterns they kept alive, and only then removes the legacy path. If 12c is still open and a deferred call site lives in a file it protects, this PR is blocked on 12c; record it.

## Work

1. Delete `legacy()` from the registrar and delete `src/shared/legacy-routes.ts`. The registrar exposes `on` and `mount` only.
2. Delete `src/client/legacy-paths.ts`. `api()`, `apiInWorkspace()`, `readInWorkspace()` and `authorizedFetch()` stop being exported from `src/client/api.ts`; `callRoute` and `readRoute` are the only exports that reach `/api`. If any of the four is still needed for the authorization bootstrap (`authorize()` in `api.ts`), keep it module-private.
3. Delete `test/legacy-routes.test.ts`'s legacy half; keep the half that proves every mounted route is a registry contract.
4. Update `docs/architecture.md` ("UI and shared contracts" row and a short paragraph under "Dependencies and boundaries") and `docs/development.md` to say: routes are registered only through `src/server/registrar.ts` from contracts in `src/shared/workspace-api.ts`; the browser reaches the API only through `src/client/workspace-api.ts`; `npm run openapi:check` verifies the generated document. One canonical explanation; link to it from `docs/cards-api.md`.
5. If reactive PR 12b has merged, finish every entry under "Deferred to after reactive 12b" in this PR. If it has not, this PR is blocked on it; record the block.

## Tests

Full baseline; every smoke in `verification.md`; `openapi:check`.

## Acceptance

`grep -rn "legacy" src/server/registrar.ts src/client/api.ts` is empty. No `string`-typed path reaches `/api` from the client. The ledger's final report lists each PR with its merge commit, review passes, documented decisions, and the "Found, not fixed" list for the owner to triage.
