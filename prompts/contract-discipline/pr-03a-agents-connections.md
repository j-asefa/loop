# PR 3a: agents and connections

Depends on PR 2. Router: `core` in `src/server/core-routes.ts`. First of two PRs for this file.

## Routes

`POST /connections`, `POST /connections/:id/refresh`, `GET /connections/:id/models`, `POST /connections/:id/reconnect`, `DELETE /connections/:id`, `GET /agents/suggest-name`, `POST /agents`, `PATCH /agents/:id`, `GET /agents/:id`, `GET /agents/:id/harness`, `GET /agents/:id/messages`, `GET /agents/:id/traces`, `GET /agents/:id/traces/export`, and the six Pi package routes under `/agents/:id/pi-*`. Eighteen routes.

## Rules specific to this PR

- `PublicConnection` already exists and already omits `secret`. Every connection response in this group uses it or a declared extension of it. The `POST /connections` body carries a credential inbound; its schema is an input schema in `src/shared` and must not be reused as a response. Confirm with a test that no response in this group contains `secret`, `token` or `apiKey` keys even when the handler is given a connection row with those fields.
- `GET /agents/:id/traces/export` streams a file. Type its `params` and `query`; its `response` is a `z.custom` marker for a non-JSON body and the registrar must not wrap `res.json` for it. Add a `kind: "stream"` marker to `RouteContract` for this case and document it in `contracts.md`'s Shape section; `GET /artifacts/:id/download` and `GET /artifacts/:id/file` in PR 3b use the same marker.
- Pi package routes return inspection results assembled from `pi-package-inspect.ts`. Type what they return today; do not restructure.

## Client

Move the corresponding call sites in `src/client` to `callRoute`/`readRoute` and delete their `LegacyClientPath` patterns, except call sites inside `App.tsx` while reactive 12b is open (record them as deferred).

## Tests

One actual-HTTP test per route as `verification.md` requires. Full baseline, `openapi:check`, `smoke:design`.

## Acceptance

Eighteen legacy keys deleted; the same number of contracts added; the ledger records the new list sizes; no handler behaviour change beyond undeclared fields being removed, each listed in the PR body.
