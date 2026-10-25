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
| Every PR in this bundle | `npm run openapi:check` (PR 1 still uses `npm run cards:check`) | The generated document matches the executable contracts; the legacy list matches the mounted routes |
| Routes the browser shell loads (PR 3a, 3b, 4, 5, 9) | `npm run smoke:design`, `npm run smoke:history` | Bootstrap, Feed, thread open, Results and Files render with no console errors and no changed network shape |
| Feed, Later, saved, scheduled sends (PR 4) | `npm run smoke:feed-events` | Working to Done transitions, saves and dismissals, scheduled-send status reads, the linked Docker source path |
| Companion, runtimes, native decisions (PR 6) | `npm run smoke:companion`, then `LOOP_BROWSER=webkit npm run smoke:companion` | Pairing, runtime auth and upgrade flows, native decision answers |
| Teams, mail, definitions (PR 7) | `npm run smoke:workspace` | Team creation from preset, review request status read, definition import |
| Social, watches, GitHub (PR 8) | `npm run smoke:social`, `npm run smoke:pulls` | Social feed reads and writes; pull request list, detail and one action preview |
| Cards fold (PR 2) | `npm run smoke:cards`, `test/card-client.test.ts`, `test/card-access*.test.ts` | Card token reads keep identical permissions, selection and cursor behavior |
| Events (PR 10) | `npm run smoke:feed-events`, `npm run smoke:reconnect`, `test/event-sockets.test.ts` | V3 frames unchanged on the wire; reconnect and epoch reset unchanged |
| Legacy removal (PR 11) | the full baseline plus every smoke above | Nothing registers outside the registrar; nothing in the client reaches `/api` outside the typed helpers |Browser smokes need Chromium and WebKit installed with `npx playwright install --with-deps chromium webkit`. A missing browser dependency is a reported block, not a passing journey.

## Regression rules

- For every route typed in a PR: one actual-HTTP test against the production app (`app` from `src/server/index.ts` on an isolated database, as `test/workspace-route-contracts.test.ts` does) that exercises a valid request, an invalid input (expect the existing `Problem` 400 shape), and the response passing its schema from real seeded rows. Response fixtures come from rows the existing tests create, never from hand-written objects.
- For every optional response field introduced for compatibility: a test that removes it from a production response and shows the client still renders.

- Test the production caller and its observable behavior, not a helper in isolation. For transport work that means a real socket against the compiled server with an isolated database, as `test/event-sockets.test.ts` does, and for the paired path a socket through the linked Docker proxy fixture.
- Use isolated databases and subprocess fixtures; never a real provider.
- For anything that removes a timer, add a test proving the replacement signal fires, and a test proving every responsibility the timer carried is still covered, including changes that happen without a write, such as approval expiry.
- For anything touching run state, keep the existing legal-transition tests green and add the new transition paths.
- For anything the client applies in place, add a shared-reducer test that feeds the same event sequence through the server projection and the client reducer and asserts identical state, including duplicate delivery, late fetch completion, reconnect, source replacement and owner change.
- For anything that changes the database representation of a projection, test mutation sequences, not only seeded end states: delete and move, folder subtree moves, expiry without a write, dismissal and undo, crash or rollback mid-sequence.
- Native async tests use the bounded waits in `test/helpers.ts`, not sleeps.

## Evidence in the PR

For each command: the exact invocation, the date, pass or fail, and for failures the relevant output. For browser smokes, the screenshot paths they wrote. Live-provider, tunnel and physical-phone checks are separate and are stated as not run unless you actually ran them.
