# PR 11: remove the legacy path

Depends on PR 10 and on both legacy lists being empty. If either list still has entries, this PR is blocked; finish the owning router first and record it.

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
