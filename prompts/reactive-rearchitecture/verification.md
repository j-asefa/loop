# Verification

Read `docs/development.md` and inspect `package.json` before choosing commands. Fixture tests establish protocol behavior; they do not establish provider availability or physical-phone acceptance. Report exactly what ran.

## Baseline for every PR

```sh
npm run typecheck
npm test -- --maxWorkers=1
npm run test:native
npm run build
```

Run focused Vitest files directly while iterating, for example `npx vitest run test/event-sockets.test.ts --maxWorkers=1`. Do not pass file paths to `npm test --`.

## Additional checks by category

| PR category | Also run | What it must show |
| --- | --- | --- |
| Event transport (PR 2, 3, 6, 7) | `npm run smoke:feed-events` | Working to Done transitions, catch-up after reconnect, HTTP fallback with sockets blocked, request budget under sustained updates, and the linked Docker source path, which proxies the socket and drops unknown query parameters today |
| Thread rendering (PR 5, 7) | `npm run smoke:history` | Older activity fetched only on request; live updates keep their own cursor |
| Companion process model (PR 8) | `npm run smoke:companion`, then `LOOP_BROWSER=webkit npm run smoke:companion`, `npm run smoke:package`, `test/cli-daemon.node.test.ts`, `test/connection.node.test.ts` | Pairing, worker ownership, restart and upgrade behave with the worker in its own process |
| Feed projection (PR 9) | `npm run smoke:feed-events`, `npm run smoke:design`, the feed snapshot tests under `test/snapshots/feed` | Membership, ordering, cursors and counts match the oracle over mutation sequences |
| Schema and migrations (PR 6, 9, 10) | every `*-migration.test.ts`, a fresh-database start, an upgrade from a database created on current `origin/main`, and simultaneous API and worker startup | Both paths start, both report the same applied set, concurrent startup does not double-apply |
| Typing and contracts (PR 1, 11) | `npm run cards:check` | Generated contracts still match executable schemas; note this proves schema generation, not cursor or tombstone equivalence |
| Containers (PR 1, 8) | `npm run build:image -- -f Dockerfile.runtime-broker -t loop-runtime-broker:local` and `node scripts/compose-smoke.mjs` when a Docker daemon exists | The runtime images still start from the compiled runtime directory |

Browser smokes need Chromium and WebKit installed with `npx playwright install --with-deps chromium webkit`. A missing browser dependency is a reported block, not a passing journey.

## Regression rules

- Test the production caller and its observable behavior, not a helper in isolation. For transport work that means a real socket against the compiled server with an isolated database, as `test/event-sockets.test.ts` does, and for the paired path a socket through the linked Docker proxy fixture.
- Use isolated databases and subprocess fixtures; never a real provider.
- For anything that removes a timer, add a test proving the replacement signal fires, and a test proving every responsibility the timer carried is still covered, including changes that happen without a write, such as approval expiry.
- For anything touching run state, keep the existing legal-transition tests green and add the new transition paths.
- For anything the client applies in place, add a shared-reducer test that feeds the same event sequence through the server projection and the client reducer and asserts identical state, including duplicate delivery, late fetch completion, reconnect, source replacement and owner change.
- For anything that changes the database representation of a projection, test mutation sequences, not only seeded end states: delete and move, folder subtree moves, expiry without a write, dismissal and undo, crash or rollback mid-sequence.
- Native async tests use the bounded waits in `test/helpers.ts`, not sleeps.

## Evidence in the PR

For each command: the exact invocation, the date, pass or fail, and for failures the relevant output. For browser smokes, the screenshot paths they wrote. Live-provider, tunnel and physical-phone checks are separate and are stated as not run unless you actually ran them.
