# Status ledger

Update after every meaningful step. A fresh session must be able to resume from "Next step" alone. Record dates as absolute dates.

| PR | State | Branch | PR URL | Review passes | Reviewed head | Next step |
| --- | --- | --- | --- | --- | --- | --- |
| 1 registrar and named legacy list | ready to merge | contracts/01-registrar | https://github.com/j-asefa/loop/pull/187 | 2 | b9966818e19453a6db5176c8c47902b119125310 | Pass 2 is complete: 3/3 reviewers, no confirmed P0/P1/P2 or security findings. All required gates pass on source 4e17c554; only STATUS edits follow the reviewed head. Fresh main remains d41c67b6. Commit/push this ledger, verify only STATUS differs from the reviewed head, squash-merge #187 pinned to that head, fetch main, mark PR 1 merged and start PR 2 from fresh main. |
| 2 one registry, one generator | todo | | | 0 | | After PR 1 merges |
| 3a agents and connections | todo | | | 0 | | After PR 2 merges |
| 3b messages, artifacts, results, personal | todo | | | 0 | | After PR 3a merges |
| 4 Feed, Later, saved, scheduled sends, run ordering | todo | | | 0 | | After PR 3b merges |
| 5 folders, artifacts, search, preferences, imports | todo | | | 0 | | After PR 4 merges |
| 6 companion, runtimes, native history, subscriptions, activities | todo | | | 0 | | After PR 5 merges |
| 7 teams, agent mail, definitions, sharing, notifications | todo | | | 0 | | After PR 6 merges |
| 8 social, watches, digests, GitHub | todo | | | 0 | | After PR 7 merges |
| 9 application-level routes and memory | todo | | | 0 | | After PR 8 merges |
| 10 events in the registry | todo | | | 0 | | After PR 9 merges |
| 11 remove the legacy path | todo | | | 0 | | After PR 10 merges and both legacy lists are empty |

States: todo, in progress, checks green, review requested, fixing findings, ready to merge, merged, blocked.

## Legacy list size

PR 1 starting inventory (2026-10-25): 227 server method/path entries, 191 client path patterns (plus query/source forms). Record remaining entries after each merge.

## Blocked

(none)

## Deferred to after reactive 12b

2026-10-25: User authorized only the string-expression narrowing rejected by `LegacyClientPath` before reactive 12b opens. Each call below is narrowed in PR 1; its typed-contract migration remains for the corresponding router PR after coordination with 12b. No moves, extraction or refactoring in `App.tsx`. Protection resumes immediately when 12b opens.

| App.tsx line at 9cd36102 | Legacy path expression | State |
| --- | --- | --- |
| 565 | `/artifacts/${artifact}` | Narrowing done in PR 1; typed migration pending |
| 792 | `/artifacts/${item.id}` | Narrowing done in PR 1; typed migration pending |
| 851 | `/results/${id}` | Narrowing done in PR 1; typed migration pending |
| 1619 | `/artifacts/${contextArtifact.id}/move` | Narrowing done in PR 1; typed migration pending |
| 1807 | `/scheduled-sends/${row.id}` | Narrowing done in PR 1; typed migration pending |
| 1955 | `/artifacts/${item.id}` | Narrowing done in PR 1; typed migration pending |
| 1976 | `/artifacts/${artifact}` | Narrowing done in PR 1; typed migration pending |
| 2578 | `/artifacts/${item.id}` | Narrowing done in PR 1; typed migration pending |
| 2617 | `/artifacts/${item.id}` | Narrowing done in PR 1; typed migration pending |
| 3235 | `/artifacts/${id}` | Narrowing done in PR 1; typed migration pending |
| 3375 | `/artifacts/${artifact}` | Narrowing done in PR 1; typed migration pending |
| 4212 | `/agents/${profile.id}` | Narrowing done in PR 1; typed migration pending |

The existing raw session read at `App.tsx:1225` (`fetch(sourceApiPath("/api/auth/get-session"))`) is also deferred: it does not require string narrowing and is outside the user-authorized App.tsx edits. Its path is named in the client list; moving it to the typed helper remains for PR 9 after 12b.

## Found, not fixed

(behaviour defects exposed by typing, with route, evidence and why the fix is out of scope here)

## Decisions made during implementation

- PR 1: Include the MCP, workflow and card-token routers omitted from the spec's file estimate, because otherwise exported raw routers would remain. Starting server list: 227 unique method/path entries; 14 existing typed contracts.
- PR 1: Preserve app route authorization stages with five private registrars named `app`, mounted at the original boundaries. Their `/api` prefix keeps request URLs unchanged for Better Auth and federation. Companion owner assignment remains before its auth routes.
- PR 1: Keep `projectionSnapshot` outside the contract wrapper through the registrar's `wrap` option, preserving synchronous body/watermark reads. Preserve Cards strict and case-sensitive routing and existing admission middleware.
- PR 1: Move typed client helpers beside private transport in `api.ts`, keeping `workspace-api.ts` exports compatible, so no exported string transport can bypass the named path union. Narrow source-routing types and existing string concatenations without changing serialized URLs.
- PR 1: Serialized file-download addresses are narrowed to the existing objects/artifact-file routes before authorized fetch. Their names are in the client legacy list; no response fields or server inputs change.
- PR 1: The production inventory test combines server and companion mounts, checking uniqueness within each profile and exact registry/list coverage across both; profile-exclusive routes cannot all be mounted in one app.

- PR 1: Full design exposed a pre-existing mail fixture mismatch: `readInWorkspace` already retries two 5xx reads, but the smoke injected only one 503 and expected an error. The fixture now keeps the source unavailable through automatic refreshes and retries, then restores it for the manual recovery/loading/navigation assertions. A trace showed an automatic refresh overlapping the manual read, so a fixed refusal count could not exhaust both reads. Production retry behavior is unchanged.

- PR 1: Rebased on notification categories PR #184 (`9e378158`); retained its preference schema and response fields while replacing only registration with the named registrar. No App.tsx or native-session change from that rebase.

- PR 1: Upstream #184 introduced the first migration outside the frozen numeric ledger. Two existing startup tests incorrectly compared all migrations to that historical ledger. They now verify every named completion and preservation of the historical numeric identities; the migration runner and SQL are unchanged.

- PR 1: The Feed-loading metadata-outage assertion used Playwright’s five-second default, shorter than the existing two- and four-second read retries. Its deadline is now ten seconds; cached data, outage visibility and explicit recovery assertions remain unchanged. Focused Chromium/WebKit checks pass.

- PR 1: Upstream #185 (`706240b2`) merged equivalent startup, mail and Feed-loading fixture fixes plus a draft-save race fix while this branch was validating. Rebased and retained all upstream versions, so those test/script fixes are no longer part of this PR’s diff. App.tsx still differs from the new base only at the 12 authorized string narrowings; reactive ledger and native-sessions.ts have no diff. All gates must run again on the new base.

- PR 1: Reactive 12a merged as #186 (`d41c67b6`); rebased cleanly after all gates passed on the previous base. Native-session imports continue to use its facade. No changes to native modules, the facade or the reactive ledger; no further App.tsx edits. Fresh gates are required on the new base.

## Verification history

2026-10-25, application implementation `bd586c0d`, checked head `ef93e6724789ce72ef0b28675beea74087812b36`, base `706240b2a2932951ac37abdd09be1d9f609e2c78`: `npm run typecheck`, `npm run build`, `npm run cards:check`, `TMPDIR=/var/tmp npm test -- --maxWorkers=1 --reporter=verbose` (204 files / 1,665 tests), `TMPDIR=/var/tmp npm run test:native` (279 tests), `TMPDIR=/var/tmp npm run smoke:history` (Chromium/WebKit) and `TMPDIR=/var/tmp LOOP_BROWSER_WORKERS=1 LOOP_DESIGN_SCREENSHOT_DIR=/tmp/contracts-01-design-screenshots-185 npm run smoke:design` (full design plus approval layout in both engines) all pass. Screenshots: `/tmp/contracts-01-design-screenshots-185/`. The first full Vitest run on this base had six timeout/lock failures during shared VM memory/I/O pressure; the affected files passed unchanged (19 tests) and the full rerun passed all 1,665. Earlier failure details are in the PR body. Fixture coverage only; no live-provider/tunnel/physical-phone checks.

2026-10-25, application implementation `b2a7f546`, checked head `16f4ad5f8d89ef74a64dd2d05e532870deea864e`, base `d41c67b6ff1d0b145d7f392c67fce146a6d9a337`: all required gates pass again. `npm run typecheck`, `npm run build`, `npm run cards:check`; `TMPDIR=/var/tmp npm test -- --maxWorkers=1 --reporter=verbose` (204 files / 1,666 tests); `TMPDIR=/var/tmp npm run test:native` (279 tests); `TMPDIR=/var/tmp npm run smoke:history` (Chromium/WebKit); `TMPDIR=/var/tmp LOOP_BROWSER_WORKERS=2 LOOP_DESIGN_SCREENSHOT_DIR=/tmp/contracts-01-design-screenshots-186 npm run smoke:design` (full design plus approval layout, both engines). Screenshots: `/tmp/contracts-01-design-screenshots-186/`. The first unit run passed 1,665 tests and timed out after the existing five-second deadline in the six-process mail arbitration test while native/browser work ran concurrently. That case passed unchanged in isolation (one passed, 59 skipped), then the complete rerun passed all 1,666 tests in 654.15 seconds. No assertion or deadline was changed. Logs: `/tmp/contracts-01-*-186.log` and `/tmp/contracts-01-vitest-186-retry.log`.

## Review history

2026-10-25, PR 1 / #187, pass 1 requested: reviewed head `dfc583882c3cd6d4c99ca9510f52318975f7d1f1`, base `d41c67b6ff1d0b145d7f392c67fce146a6d9a337`, preflight fingerprint `915d53c2121abb3e4842038a6e9976441e31215a9ff9e12c21a7c44a11e50418`. All required checks pass on the same code; only STATUS commits follow checked head `16f4ad5f`. Capture: 94 changed paths, 1,090 captured files, 268,971 diff bytes, 11,036,379 context/before bytes, 412,372 maximum blob bytes, no omitted changed files. Review ID, coverage and findings pending the single requested review; no gate result yet.

2026-10-25, PR 1 / #187, pass 1 result: review `10085161-7754-4cd2-989f-4fa6a7075b34`, lead conversation `28a3f7ac-d5ba-4f09-a70f-cdfd8c30ee08`, fingerprint `915d53c2121abb3e4842038a6e9976441e31215a9ff9e12c21a7c44a11e50418` matches the preflight. All three reviewers completed with no errors; no confirmed introduced P0/P1/P2 or security findings. Lead retains unverified concerns about automatic OPTIONS/admission, file-URL compatibility, source-navigation coverage, disabled module isolation and native-history fall-through. Checking the concrete behavior before determining the gate. No code change yet.

2026-10-25, pass 1 follow-up: isolated actual-HTTP comparison against base `d41c67b6` confirmed early automatic OPTIONS responses for former app registrations and a changed `/runs` Allow header. App registrars now use generated OPTIONS fall-through on each declared non-ALL route, preserving parent admission and later routers. The inventory excludes only these marked generated handlers, while still checking every declared endpoint; default child-router OPTIONS and explicit ALL handlers remain unchanged. Production regressions cover single/multi-user refusal, bearer admission and the later `/runs` POST method. A repeated comparison across multi-user, single-user and companion profiles, including auth wildcard routes and native-history/workspace non-matches, now has zero differences (`/tmp/contracts-options-fixed-comparison.json`). Focused HTTP/registrar/inventory: 16 tests pass; source/typed-client: 15 tests pass. Typecheck/build/cards pass; fresh full gates pending.

Other pass 1 concerns: every current FilePreview caller either constructs an object/artifact-file URL, consumes those producer fields, or uses `loopFileUrl` to normalize that same family; local and source-qualified paths plus query forms remain accepted. No compatible older producer with another path was found; older linked-source fixtures remain covered by history/design, not a claim of every historical version. The source-navigation regression now exercises `useSourceRoute`/`callRoute` for both retained and new source callbacks. The full test log reports 204 isolated workers and no configuration disables isolation; the process-wide duplicate guard is required for production startup. Native-history has only its own non-overlapping route prefix and the baseline comparison confirms fall-through for unmatched history/workspace paths. No protected file was edited while addressing the review.

2026-10-25, pass 2 pre-review checks, source `4e17c554b3e4287033362ecc2d5d06a1ace8295f`, base `d41c67b6ff1d0b145d7f392c67fce146a6d9a337`: PASS `npm run typecheck`, `npm run build`, `npm run cards:check`; PASS `TMPDIR=/var/tmp npm test -- --maxWorkers=1 --reporter=verbose` (204 files / 1,668 tests, 744.40 seconds); PASS `TMPDIR=/var/tmp npm run test:native` (279 tests); PASS `TMPDIR=/var/tmp LOOP_BROWSER_WORKERS=2 LOOP_DESIGN_SCREENSHOT_DIR=/tmp/contracts-01-pass2-design-screenshots npm run smoke:design` (all design plus approval layout, Chromium/WebKit); PASS `TMPDIR=/var/tmp npm run smoke:history` (both engines, no screenshots emitted). Native/browser work finished before the full unit run; no failures in this correction's gates. Logs `/tmp/contracts-01-pass2-*.log`, screenshots `/tmp/contracts-01-pass2-design-screenshots/`. No live provider/tunnel/physical-phone validation.

2026-10-25, PR 1 / #187, pass 2 requested: reviewed head `b9966818e19453a6db5176c8c47902b119125310`, base `d41c67b6ff1d0b145d7f392c67fce146a6d9a337`, preflight fingerprint `4889652b86e9e002d7d4982ca62f1cd432f3c0b48a56fb51f39c39e26175c62f`. All required checks pass on source `4e17c554`; only STATUS commits follow. Capture: 95 changed paths, 1,090 captured files, 277,570 diff bytes, 11,062,840 context/before bytes, 412,372 maximum blob bytes, no omitted changed files. Review ID, coverage and findings pending this single request.

2026-10-25, PR 1 / #187, pass 2 result: review `435f5c62-5ae2-4a96-a2f8-7c0692af2adf`, lead conversation `f137efea-4faf-488d-b85b-889351c99c31`, reviewed head `b9966818e19453a6db5176c8c47902b119125310`, base `d41c67b6ff1d0b145d7f392c67fce146a6d9a337`, fingerprint `4889652b86e9e002d7d4982ca62f1cd432f3c0b48a56fb51f39c39e26175c62f`. P0=0, P1=0, P2=0 and security=0 confirmed findings; coverage complete, all three reviewers completed without errors/truncation: `03298c9a-2015-4bf1-8d6f-c2eec4e4af55`, `59d63ff3-1da9-4403-9f8a-2fd44af90752`, `c772c9f9-3710-4f3d-a8a8-c54834094a13`. The OPTIONS correction and typed source-navigation regression are in this reviewed head. Review is static and did not rerun tests. Remaining unverified limits: every historical file URL (including the legacy `/artifacts/:id/download` alias), independently reconstructed app instances, and exhaustive middleware/dynamic-path parity. Current producers, required process-wide duplicate detection, focused HTTP comparisons and source-navigation/full browser gates support proceeding; no concrete affected caller or ranked finding was established. These limits are documented in the PR, not claimed as verified. Fresh main is unchanged and the merge gate holds.
