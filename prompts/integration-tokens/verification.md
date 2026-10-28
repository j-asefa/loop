# Verification

Read `docs/development.md` and inspect `package.json` before choosing commands. Fixture tests establish protocol behavior; they do not establish provider availability, a real receiver on the internet, or physical-phone acceptance. Report exactly what ran.

## Baseline for every PR

`npm run check` is the convention gate (Prettier check, typecheck, `openapi:check`, source boundaries, formatting policy, registry route inventory, workspace event contract and every `test/*-contracts.test.ts`). Run it on the exact commit you submit and paste its `check:` lines into the PR; repeat after every revision. Then:

```sh
npm run check
TMPDIR=/var/tmp npm test -- --maxWorkers=1
TMPDIR=/var/tmp npm run test:native
npm run build
```

Use `TMPDIR=/var/tmp` for tests and smokes. Run focused Vitest files directly while iterating; do not pass file paths to `npm test --`. A check that did not run is reported as not run, never as passing.

## Additional checks by category

| PR | Also run | What it must show |
| --- | --- | --- |
| 1 tokens | `npm run smoke:cards`, `test/card-access*.test.ts`, `test/card-client.test.ts`, every `*-migration.test.ts`, a fresh-database start and an upgrade from a database created on current `origin/main` | Both legacy grants keep identical permissions, selection, Done refusal, read bookkeeping, cursors and rate limits on server and paired host; `read` admits exactly its routes; no token reaches a session-only, peer, fleet or transport route; no token can write |
| 2 identity | the actual-HTTP contract tests for `submit`, the reply route, `runAction` (cancel, dismiss), `runWithdraw`, `runReorder`, `runMove`, approval and native decisions | A replayed token write returns the first status with the current projection and performs no second effect; an uncertain outcome replays as 409 without dispatch; a token write without identity is refused with the `Problem` 400 shape |
| 3 events | `test/event-sockets.test.ts`, `npm run smoke:feed-events`, `npm run smoke:reconnect` | Browser frames unchanged on the wire; the token endpoint delivers the same committed events with its own durable cursor; revocation ends an idle stream within the bound |
| 4 webhooks | the fixture receiver tests described in pr-04, `npm run smoke:feed-events` | Exactly one delivery identity per transition per subscription across retries and restarts; signature verifies; credentialed URLs refused everywhere; private and loopback URLs refused when `companionMode` is false and accepted when true; link-local refused; redirects not followed; dead-lettered subscriptions visible in Settings |

## Regression rules

- Test at the owning production entrypoint on an isolated database with a real bearer token created through the production creation route: the server `app` from `src/server/index.ts` for server admission, as `test/workspace-route-contracts.test.ts` does, and the paired host from `src/host.ts` for companion admission. A behaviour that exists on both paths is tested on both.
- Every admission value gets a positive and a negative test: the routes it admits, and one session-only route, one peer or fleet route and one other-scope route it is refused on. Admitted reads are tested for GET and HEAD alike; `write` and `approvals:decide` admit only mutating methods, so their positive tests use those methods and their negative tests include a GET on a `read` route.
- Credential-free responses: for each token-reachable route, a test seeds a row with a secret-like column and shows the response omits it. The contract rules already require this for typed routes; here it is re-asserted under token authentication because the admission path differs.
- Webhook deliveries are tested with an in-process receiver that records every request, can refuse, time out, redirect, and return 200 after a timeout, so the same-identity retry and receiver-side deduplication are both exercised. Crash mid-send is simulated by killing the delivery between the lease and the HTTP call.
- Never a real external receiver, provider or push service.

## Evidence in the PR

For each command: the exact invocation, the date, pass or fail, and for failures the relevant output. State explicitly that no live receiver or provider was used.
