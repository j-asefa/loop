# PR 8b: PR watches and GitHub pull requests

Depends on PR 8a (merged 2026-10-26 as `ef3b8f5c`, #214). Routers: `prWatches` (4), `githubPulls` (8). Twelve routes. A combined implementation was preserved in `/tmp/contracts-08-combined` during 8a; reapply against fresh `origin/main` rather than trusting it, since the Prettier pass (`07704acc` to `5c69d6d9`) reformatted both files.

## Routes

PR watches: `GET|POST /pr-watches`, `POST /pr-watches/:id/resume`, `DELETE /pr-watches/:id`. GitHub: `GET /github/pulls`, `GET /github/pulls/:owner/:repo/:number`, its `/files`, `/commits/:sha/files` and `/file` reads, and `POST …/reviews`, `…/comments`, `…/merge`.

## Rules specific to this PR

- GitHub responses are projections of GitHub API data (`github-pulls.ts`). The connection token never appears; declare only the fields the Pull requests tab and the conversation PR status card (#206, `src/shared/pull-state.ts`, `pull-requests.ts`) render, and test that a GitHub payload containing token-like fields is stripped.
- The three GitHub write routes are single-shot actions Loop never retries (`docs/workspace.md`, "GitHub pull requests"). Their bodies carry the head commit they are pinned to; required in the schema.
- `GET …/file` returns file content for the diff viewer; if the handler streams, use `kind: "stream"`.
- PR watches carry resume identities; required exactly as the handler requires them.

## Client, tests, acceptance

Move call sites in the pull-request views; record any in protected files as deferred. `npm run check`, full baseline, `smoke:pulls`. Neither router registers through `legacy`.
