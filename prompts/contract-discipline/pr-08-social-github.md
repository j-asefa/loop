# PR 8: social, watches, digests and GitHub pull requests

Depends on PR 7. Routers: `news` (22), `feedWatches` (5), `feedDigests` (4), `prWatches` (4), `githubPulls` (8). Forty-three routes; split as 8a (`news`, `feedWatches`, `feedDigests`) and 8b (`prWatches`, `githubPulls`) if the capture does not fit.

## Routes

Social (`news.ts`): the `/social/*` family: `unread`, root, `search`, `image`, `mutes` (GET/POST/DELETE), `read` (POST/DELETE), `dismiss` (POST/DELETE), `preferences` (GET/PUT), `read-all`, `feeds` (GET), `feeds/:id` (PUT/DELETE), `sources/discover`, `sources` (PUT), `sources/:id` (DELETE), `opml` (GET/POST). Watches: `GET|POST /social/watches`, `POST /social/watches/preview`, `PATCH|DELETE /social/watches/:id`. Digests: `GET|POST /social/digests`, `PATCH|DELETE /social/digests/:id`. PR watches: `GET|POST /pr-watches`, `POST /pr-watches/:id/resume`, `DELETE /pr-watches/:id`. GitHub: `GET /github/pulls`, `GET /github/pulls/:owner/:repo/:number`, its `/files`, `/commits/:sha/files` and `/file` reads, and `POST …/reviews`, `…/comments`, `…/merge`.

## Rules specific to this PR

- `GET /social/image` streams; use the `kind: "stream"` marker.
- GitHub responses are projections of GitHub API data (`github-pulls.ts`, 854 lines). The connection token never appears; declare only the fields the Pull requests tab renders, and test that a GitHub payload containing `token`-like fields is stripped.
- The three GitHub write routes are single-shot actions Loop never retries (`docs/workspace.md`, "GitHub pull requests"). Their bodies carry the head commit they are pinned to; required in the schema.
- Social preferences and OPML are owner-private; OPML upload is a text body with the existing size limit.

## Client, tests, acceptance

Move call sites in `Social.tsx` and the pull-request views; record deferred ones. Full baseline, `openapi:check`, `smoke:social`, `smoke:pulls`. None of the five routers registers through `legacy`.
