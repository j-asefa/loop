# PR 9c: memory and workflows

Depends on PR 9b. Routers: `memoryRoutes` (9) and `workflows` in `src/server/workflows/routes.ts` (6). Fifteen routes. After this PR the server legacy list is empty; record it in the ledger.

## Routes

Memory: `GET /conversations/:id/memory`, `GET /memory`, `PUT /memory/policy`, `GET|DELETE /memory/sources/:id`, `POST /memory/notes`, `PATCH /memory/notes/:id`, `GET /memory/notes/:id/versions`, `GET /runs/:id/memory`. Workflows: `GET /workflows`, `GET /workflows/:id`, `POST /workflows`, `POST /workflows/validate`, `POST /workflows/:id/run`, `GET /runs/:id/steps`.

## Rules specific to this PR

- Memory notes have versions and an outbox (`docs/architecture.md`, "Memory, tools and files"). Responses are display projections; recall content is untrusted historical evidence and the schema does not change that.
- `POST /workflows/:id/run` starts work and carries an idempotency key as `submit` does; required. `POST /workflows/validate` returns a validation report; type the report's issue shape, not the workflow script.
- Workflow definitions are scripts; the body is text with the existing size limit, validated by the handler as today.
- `GET /runs/:id/steps` is a run projection; reuse `PublicRun` fields where they overlap and declare the step shape once.

## Client, tests, acceptance

Move call sites. `npm run check`, full baseline, `smoke:workspace`. Neither router registers through `legacy`; the server legacy list file has no entries.
