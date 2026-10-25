# PR 4: Feed, Later, saved, scheduled sends and run ordering

Depends on PR 3b. Router: `mobile` in `src/server/mobile-routes.ts`, 27 untyped routes. The file is 152 lines of registrations over `mobile-return.ts`; the work is in the schemas, not the handlers.

## Routes

`PUT /conversations/:id/position`, `PATCH /feed/:id`, `GET /feed/away`, `POST|DELETE /messages/:id/saved`, `GET /saved`, `PUT /saved/label`, `GET /conversations/:id/outline`, `POST|GET /later`, `DELETE /later/:id`, `POST /later/:id/snooze`, `POST /later/:id/reopen`, `POST /projects/:id/opened`, `GET /projects/summary`, `POST|GET /scheduled-sends`, `DELETE|PATCH /scheduled-sends/:id`, `POST /scheduled-sends/:id/retry`, `POST /runs/:id/reorder`, `PATCH /runs/:id`, `POST /runs/:id/withdraw`, `POST /runs/:id/move`, `POST /conversations/:id/fork`, `GET /conversations/:id/usage`, `GET /snippets`.

## Rules specific to this PR

- Feed item shapes already exist as `FeedItem`; `PATCH /feed/:id` returns whatever the handler returns today, typed against `FeedItem` or a declared subset. Do not change the Feed query in `mobile-return.ts`; reactive PR 7b/9b own that file's reducer and are blocked pending the owner's decision.
- Scheduled sends and Later carry idempotency or request identities on creation today. Those fields are required in the body schema exactly as the handler requires them. Nothing becomes optional.
- Run reorder, move and withdraw change queue state. Their responses are `PublicRun` or `Ok` as today; if a handler returns a bare array of runs, declare `z.array(PublicRun)`.
- `GET /feed/away` and `GET /projects/summary` are summaries; declare their fields from the handler, with `.optional()` only where an older source genuinely omits a field (check `mobile-return.ts` history, not the client's tolerance).

## Client

Feed, Later and saved call sites live mostly in `Feed.tsx`, `Social.tsx` and hooks, not `App.tsx`; move them. Record any `App.tsx` call sites as deferred.

## Tests

Actual-HTTP tests per route. Full baseline, `openapi:check`, `smoke:feed-events`, `smoke:design`.

## Acceptance

`mobile-routes.ts` registers nothing through `legacy`. Feed smokes unchanged.
