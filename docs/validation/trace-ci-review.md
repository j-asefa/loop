# Trace CI fix and combined UI review

Starting point: PR #17 at `df9a9143de3cce8b91624a141b64964b6d76e101`, after the `38e52a0` ACP documentation and `d13483a` browser work. Work is isolated on `fix/trace-ci-safety`; no merge or deployment.

## Diagnosis

Fetched `gh run view 36348358825 --log-failed`. The fatal assertion is `traces-journey.mjs:519`, forbidding `pull_request_review_write` anywhere under `.messages`. Public legacy tool records now intentionally render as collapsed shared activity panels beside the final answer, including the fixture's `Public update` records. The tool name and public review failure are valid activity content, not assistant prose. The two `Tool input schema is unsupported` errors are intentionally thrown for `failure-visibility-fixture` by `tests/helpers/install.ts`; the failure-visibility journey passed before the trace failure.

Separately, reviewing the public/private boundary uncovered a real regression: `legacyTools` did not use the existing `publicTraceFilter`, so old native `StructuredOutput` envelopes and their receipts could reappear through `/activities` even though agent traces hide them. An API regression reproduced both internal IDs in the response before the production fix (5 tests passed, 1 failed). The fix reuses the established SQL filter before limiting/projecting legacy records. Stored records remain intact, and a non-native public tool named `StructuredOutput` remains supported.

The updated browser journey requires exactly one collapsed public review activity, expands it and checks its public error, retains tool exclusion from all 197 assistant Markdown bodies, and checks that internal envelopes, receipts and raw tool metadata are absent from both the conversation DOM and activity API. It also verifies the expected 182 public legacy tool panels. This replaces an obsolete location assertion with explicit public rendering and stronger internal-data assertions.

## Review scope

Reviewed the combined changes from `main` in Conversation, ActivityRecords, ActivityPanels, NativeHistory, HarnessPicker, SessionActivityControls, activity projection/merging, provider/connection selection and responsive activity CSS. The review checks display-only rendering, literal hostile text, bounded/scrollable diff and output, live/completed history, generation/revision-bound controls, pending versus confirmed settings, dynamic catalog updates, and separation of public activity from assistant prose. The native-envelope leak found in this review is fixed in this branch.

The `38e52a0` documentation preserves the actual supported ACP scope and explicitly separates deterministic fixtures from authenticated upstream evidence. No real authenticated model calls were made. Final approval of the eventual combined PR head and root's separately running broad-suite results remain separate gates; this branch does not approve an unseen later head.

## Validation

See [evidence/trace-ci](evidence/trace-ci) for the baseline browser assertion reproduction and API regression, plus completed validation logs. Browser commands use the existing local Chromium runtime libraries and fonts as documented in [acp-deterministic-browser.md](acp-deterministic-browser.md). Tests use isolated databases and deterministic providers.

- `npm run smoke:journey`: passed, exit 0; all 17 journey summaries passed, including trace browser safety/pagination, project attention, approvals, provider/native pairing, composer, catalog, and cross-user isolation. Baseline at `df9a914` reproduced the exact CI assertion failure.
- Focused Vitest: **34/34 passed in 5 files** (`activities-server`, `traces`, `activity-panels`, `activities-integration`, `runtime-activities`). The new API regression failed before the production filter fix and passed afterward.
- `npm run typecheck` and final `npm run build`: passed. Build retains the existing large-chunk warning.
- `npm run test:browser:acp` against the final rebuilt application: passed at **390×844 and 1280×844**. Captures and replay/count evidence are included here. Visually reviewed the mobile completed conversation and desktop pending-approval recovery.

The initial attempt to launch an additional browser check while the journey and tests overlapped aborted before producing test output. This workspace's cgroup has a 256-task limit (222 tasks observed during overlap); checks were subsequently serialized and completed. Only completed runs above count as validation.

- `node --import tsx scripts/activity-database-browser.mjs`: passed at **390/1280**, covering real routers/SQLite, live and saved history, pending decisions, confirmed/requested/rejected settings, dependent option/catalog removal, hostile content, scrolling, and generation replacement.

- `node scripts/activity-panels-browser.mjs`: passed at **390/1280**, including dynamic command and stale-response isolation checks.
- `git diff --check`: passed.

Draft UI verdict: ready for draft integration with this fix; no further blocker found in the reviewed combined UI. This is not final approval of PR #17: integrate the fix, verify the actual final combined head and root's broad-suite results, and preserve the separately documented live-agent gate. No GitHub approval review, merge, deployment, or paid call was performed.
