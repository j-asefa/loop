# PR 3b: messages, artifacts, results and personal routes

Depends on PR 3a. Router: `core`, remaining routes.

## Routes

`GET /messages`, `GET /messages/:id`, `PATCH /results/:id`, `GET /artifacts/:id/file`, `GET /artifacts/:id/download`, `GET /me/files`, `GET /me/decisions`, `GET /me/profile`, `PUT /me/profile`, `GET /me/prompts`. Ten routes. After this PR `core-routes.ts` has no legacy registrations.

## Rules specific to this PR

- Message responses extend the existing `PublicMessage`. `metadata` stays `Text`.
- The two artifact file routes use the `kind: "stream"` marker from PR 3a. Their `params` are typed; their authorization checks in the handler do not move.
- `/me/*` routes serve `user-profile.ts`, `personal-history.ts`, `personal-files.ts` and `personal-decisions.ts`. Their responses are owner-private but not credentials; type them as they are.
- `PATCH /results/:id` accepts a partial update today. Type the accepted fields exactly as the handler reads them; anything the handler ignores is not in the schema.

## Client, tests, acceptance

As PR 3a. `core-routes.ts` registers nothing through `legacy`. Also run `smoke:history` because thread file links use the artifact routes.
