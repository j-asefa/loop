# PR 11: typed rows and typed routes

Depends on PR 10. Split into 11a (rows) and 11b (routes).

## Goal

JSON strings are the type system today: `payload`, `metadata`, `models` and `secret` are `string` on every row type, parsed at about two hundred sites in `src/server` and cast with `as` at nearly four hundred. `owned<T>` returns whatever the caller claims. `Run` is defined in both `src/server/queue.ts` and `src/shared/types.ts`, and its `state` is `string` although the legal-transition map enumerates the union. On the client, about 80 `api()` calls are untyped. Make the row layer and the route layer schema-first, starting with the modules this bundle already touched.

## Rows (11a)

1. Define zod schemas for each JSON column: `RunPayload` (start from the `Snapshot` in `agent-runtime.ts`), `MessageMetadata`, `ArtifactMetadata`, `ConnectionMetadata`, `ConnectionModels`, `ConversationMetadata`. Derive `RunState` from the legal-transition map so adding a state is one edit. Secrets stay sealed; schemas for `secret` columns describe the sealed envelope.
2. One `Run` type with `state: RunState` and a parsed `payload`; remove the duplicate.
3. Replace `owned<T>` with per-table functions that parse once and return typed rows. Keep the generic for unconverted tables but make it return `unknown` so every remaining use is visible.
4. **Legacy data, fail closed for execution.** Runtime validation of existing rows can reject data that the code accepts today. The compatibility rule is narrow: an absent field that the current code treats as optional display data gets a documented default on read. An invalid present field in anything that carries identity, routing, permission or a sealed envelope, for example `reviewId` and `teamId` in `RunPayload` (checked by `assertReviewIdentity` in `agent-runtime.ts` around line 518), `loopHarness` in `ConnectionMetadata` (which selects native execution), and `permissionMode`, fails closed: the run or connection is not executable and the failure is recorded with the row id. A UI may render such a record as unavailable; it may not make it executable by falling back. Schemas are strict on write. Each validation that could reject existing data is listed in the PR body with its rule, and the tests include malformed-present cases, not only absent-field round trips.
5. Convert the modules changed in PRs 2 to 9 first; list what remains in the ledger.

## Routes (11b)

1. A thin helper, `route({ params, query, body, response }, handler)`, built on the existing Express app and `Problem` error handling, validating input with zod and typing the response. No framework swap.
2. **Public projections, not row schemas.** Responses use explicit response schemas; internal row schemas for connections, runs or secrets are never exported to the client. Build the projection types from the existing route output.
3. Apply to the routes the client calls most: bootstrap, feed, conversation page, runs, results, approvals, native decisions, session controls. Export their contracts to the client so `api()` is typed from the same schemas; remove `any` defaults at converted call sites.
4. Extend `scripts/cards-openapi.mjs` to emit the converted routes or document why not; `cards:check` stays green.

## Tests

- Schema round-trips against fixtures captured from the existing tests' databases, including rows that exercise the lenient-read rule.
- Route helper: invalid input produces the same `Problem` shape the error handler already returns.
- The full baseline; `cards:check`.

## Acceptance

No `as Run`, `as any` or `JSON.parse(run.payload)` in the converted modules; converted client calls compile against route contracts; every validation that could reject existing data has a documented compatibility rule.
