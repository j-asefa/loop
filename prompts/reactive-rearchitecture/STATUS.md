# Status ledger

Update after every meaningful step. A fresh session must be able to resume from "Next step" alone. Record dates as absolute dates.

| PR | State | Branch | PR URL | Review passes | Reviewed head | Next step |
| --- | --- | --- | --- | --- | --- | --- |
| 1a runtime compilation and staging | ready to merge | reactive/01a-runtime-build | https://github.com/j-asefa/loop/pull/144 | 1 | 2783f9b09fe9d391af6da2f156a410726791e468 | Gate met: refresh main, squash-merge #144 pinned to final ledger-only head, record merge, then start 1b |
| 1b shared runtime helpers in TypeScript | todo | | | 0 | | After PR 1a merges; convert the 13 declared modules and their callers |
| 1c standalone runtime processes in TypeScript | todo | | | 0 | | After PR 1b merges; convert remaining modules and include all runtime in typecheck |
| 2 ordered change bus | todo | | | 0 | | After PR 1c merges |
| 3 typed invalidations | todo | | | 0 | | After PR 2 merges |
| 4 signal-bound runs | todo | | | 0 | | After PR 2 merges |
| 5 thread open from cache | todo | | | 0 | | After PR 3 merges |
| 6 complete change signalling | todo | | | 0 | | After PR 3 merges |
| 7 projection deltas and timer removal | todo | | | 0 | | After PR 6 merges |
| 8a worker boundary extraction | todo | | | 0 | | After PR 4 merges |
| 8b worker process activation | todo | | | 0 | | After PR 8a merges |
| 9a shadow feed cards | todo | | | 0 | | After PR 6 merges |
| 9b feed cards switch | todo | | | 0 | | After PR 9a merges |
| 10 migration identity | todo | | | 0 | | After PR 9b merges, or earlier if collisions block work |
| 11 typed rows and routes | todo | | | 0 | | After PR 10 merges |
| 12 split god modules | todo | | | 0 | | After PR 11 merges |

States: todo, in progress, checks green, review requested, fixing findings, ready to merge, merged, blocked.

## Blocked

(none)

## Decisions made during implementation

- 2026-10-23, PR 1: split into compilation/staging (1a), shared helpers (1b), and standalone processes (1c). The 27 source modules total approximately 168 KB before conversion: deletion plus addition alone exceeds the 300 KB review diff limit, and the initial bundle adds 77 KB of diff. Each split keeps all shipping paths usable. The original bundle is the first branch commit, `02d3a37f30fdd03f5533c1f5a8fc67b44870ecec`, based on `0c772683f3483ab073a28b476709c355e29713da`.
- 2026-10-23, PR 1a: emit standalone `.mjs` files for both package support assets and Docker runtime images. Source imports may use `.ts`; staging rewrites those paths. Existing Docker entrypoint names and deployment/Bake targets remain valid.
- 2026-10-23, PR 1a: include two minimal baseline test repairs required for the merge gate, independently reproduced on untouched `origin/main` (`0c77268`). The Feed fixture inserted a native decision while its run was `running`, although production only presents pending decisions on `awaiting_approval` runs; seed the legal state and additionally assert that resuming hides the old decision. The 6,000-message transcript fixture exceeded Vitest's five-second timeout (8.6 seconds on this VM); give that one test a bounded 30-second budget without reducing its data, query-plan, or pagination assertions. No production behavior changes.

## Review history

- 2026-10-23, PR 1a / #144, pass 1 completed: head `2783f9b09fe9d391af6da2f156a410726791e468`, base `0c772683f3483ab073a28b476709c355e29713da`, fingerprint `e465f1895b29e0a7e9ed1ef1c32b6d12de1b66fd5593fea07e84e5e2fe4adf22`; review `c57e2bd0-fe37-4675-803e-c1cbfd68a6a8`, lead conversation `39b8518b-4601-4ce7-837a-799904b2d321`, lead run `e4b87db4-6229-4d80-a694-a038ffcfd315`. P0/P1 0; security findings no; P2 findings none. All 3 reviewers completed without errors/cancellation/interruption (correctness `32b61699-5f15-440b-a27c-3ee23c92fd9e`, regressions `5faedfc2-b8cf-4c1c-91d1-497e2d744aed`, security `59ab37bc-e4bb-4018-a44e-4f4c07138853`). Lead excluded one reviewer's searches in another checkout and reported partial broader source-reference coverage; author checked those references at the exact reviewed commit and documented this limitation and executed package/container evidence in the PR. No code fixes required. Tool timed out after 300 seconds without IDs; recovered the unique existing review using its exact fingerprint, head and team, then read only that review by id/owner/fingerprint. No duplicate request. Subsequent branch commits touch only this ledger.

## Verification progress

- 2026-10-23, PR 1a: `npm run typecheck`, `npm run cards:check`, `npm run build`, `npx vitest run test/build-identity.test.ts test/runtime-contract.test.ts --maxWorkers=1` (43 tests), and `npm run build:image -- -f Dockerfile.runtime-broker -t loop-runtime-broker:local` passed. Initial sandbox attempts failed with `spawnSync EPERM`; reruns with subprocess access passed. The first full Vitest/Compose runs were interrupted before completion and do not count as passing. Rebuilt locked SQLite/esbuild dependencies and verified in-memory SQLite; `npx vitest run test/cards.test.ts --maxWorkers=1` passed (41 tests). Full checks are being rerun; Compose uses isolated project `loop-reactive-01a` with no host ports.
- 2026-10-23, PR 1a: isolated Compose build and `docker compose -p loop-reactive-01a -f compose.yaml -f /tmp/reactive-01a-compose.yaml exec -T loop node scripts/compose-smoke.mjs` passed; API/worker health, both real unsigned runtimes, and Claude's sign-in URL/cancel flow were exercised without provider login or inference. The fixture stack and its data volume were removed afterward. Production snapshot preflight at `1585d370bf2036266cef9e23f4ba9d55327d3143`: 23 changed files, 90,265 diff bytes, no changed file omitted.
- 2026-10-23, PR 1a: diagnosed native workspace test failures as existing `/tmp/.git` contamination (production correctly rejects ambiguous Git ancestry). Left it untouched. With `TMPDIR=/var/tmp/loop-reactive-f35d4a5e`, native-workspaces and harness-routing passed all 51 tests using the repository's sanitized test environment. Stopped the contaminated full suite with exit 130 and restarted full Vitest/native checks with that TMPDIR. Mobile continuity and transcript paging failures from that run still need diagnosis.
- 2026-10-23, PR 1a: untouched-main reproduction confirmed both remaining failures: mobile-continuity expected an answer action but received null; conversation-paging exceeded its 5,000 ms timeout. Applied the fixture/state and timeout corrections above; rerun those tests and the baseline before review.
- 2026-10-23, PR 1a: baseline repairs passed all 16 focused tests; final `npm run typecheck` passed at `4a2bf8d`. `TMPDIR=/var/tmp/loop-reactive-f35d4a5e npm run test:native` passed all 199 tests (239.5 seconds). Full Vitest is running with verbose progress/exit diagnostics; package smoke remains pending.
- 2026-10-23, PR 1a: `TMPDIR=/var/tmp/loop-reactive-f35d4a5e npm run smoke:package` passed, including its production build, clean tarball installation, native fixture run, pairing/restart/stop, server profile, and upgrade between packed builds behind one fixture connection service. No real tunnel was used.
- 2026-10-23, PR 1a: full diagnostic Vitest run completed with 168 files/1,322 tests passing and one timeout: conversation-feed-state's mutation test took 5,089 ms against the existing 5,000 ms default. That untouched-main file passed alone (3 tests, mutation case 3,981 ms). Running `TMPDIR=/var/tmp/loop-reactive-f35d4a5e npm test -- --maxWorkers=1` without concurrent package/container checks before deciding whether another test-budget change is needed. No assertion failure remained.
- 2026-10-23, PR 1a: final `TMPDIR=/var/tmp/loop-reactive-f35d4a5e npm test -- --maxWorkers=1` passed all 169 files / 1,323 tests in 332.5 seconds with no concurrent build workloads. No further test-budget change was needed. Baseline, Cards, package and real-container checks are green; code head is `4a2bf8d` with subsequent ledger-only commits.
