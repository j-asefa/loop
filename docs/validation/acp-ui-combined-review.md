# ACP combined UI review — 2026-09-27

Reviewed `2daa6a4` in isolated worktree `acp-ui-review`, branch `feat/acp-ui-combined-review`. Root owns comprehensive suites and the consolidated PR. This review does not merge, deploy, or approve an unseen final PR head.

## Fix and regression evidence

A text setting rejected by NativeSessions before adapter dispatch retained its requested text in the editable field. The adapter revision did not change, so the uncontrolled input's revision key never reset. The browser reproduction expected `Original` but received `Unconfirmed` after the production active-turn 409 response. The fix restores the confirmed field value when submitting, while the existing pending message displays the request. The input key also includes generation so a replacement process with a reused revision resets its draft.

The database browser now exercises this rejection at both viewport sizes and verifies zero adapter writes. Its text option is synthetic; this is a shared-control regression, not evidence that a particular upstream harness exposes text settings.

## Packet coverage and limits

| Packet browser requirement                           | Evidence and remaining gap                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing/ACP connection selection and setup errors   | Production never-started settings error and injected connection failure are checked. Actual connection selection and ACP enrollment/login are **not** exercised by these two scripts.                                                                                      |
| Plan progression, diffs, output                      | Production Conversation renders NativeSessions-ingested records through migrated SQLite and real routers at 390×844 and 1280×844. Adapter content is deterministic.                                                                                                        |
| Reload/reconnect mid-run with pending approval       | Pending approval survives reload. Disconnect/replacement settings become read-only or rediscovered with generation checks. This does **not** prove full WebSocket/auth reconnect or an upstream ACP permission response.                                                   |
| Settings confirmation/rejection and dynamic commands | Database fixture checks requested/confirmed separation, pre-dispatch and adapter rejection, dependent option removal, stale generation rejection and catalog removal. Component fixture checks command selection, removal and late responses across conversation switches. |
| Completed history, hostile content, bounds/scroll    | Managed database history, completed reload, broker deduplication, literal hostile content, viewport bounds and output follow/scroll behavior are covered. External CLI history discovery is outside browser coverage.                                                      |

The database driver seeds a run, uses an injected in-process adapter, marks completion/approval answered itself and manually dispatches workspace-change browser events. It does not intercept production read responses. The component driver **does** stub catalog HTTP responses and has no backend. Neither is an authenticated real-agent run or full application authentication-stack check. The deterministic ACP subprocess tests are a separate protocol gate, not live upstream compatibility evidence.

## Executed results

- Typecheck and production build: passed; Vite reports its existing large-chunk warning.
- Focused Vitest: **38 passed in 5 files**.
- Native direct/ACP subprocess tests: **19 passed**.
- Database browser: **passed at 390×844 and 1280×844**, including the new unchanged-revision text rejection.
- Component browser: **passed at both widths**.
- `git diff --check`: passed.

Logs, including the pre-fix rejection reproduction, are in [evidence/acp-ui-combined](evidence/acp-ui-combined). Screenshots are included in the accompanying review evidence archive. Visual inspection found literal hostile content and contained diff scrolling at mobile and desktop widths.

One intermediate run timed out at a later setup-page navigation while other checks were running. The navigation timeout is now 60 seconds (assertion timeout remains 15 seconds); a complete rerun after the build passed. The timeout alone does not establish a production defect. An earlier driver iteration also needed to close the conversation-options menu after the new regression before resuming the existing journey.

## Reproduction

Node 24.21.0; dependencies from `npm ci --ignore-scripts --no-audit --no-fund`, then `npm rebuild better-sqlite3`. Browser: Playwright Chromium 1243, ARM64. This host requires untracked Debian runtime libraries and fonts staged in the earlier checkout:

```sh
export LD_LIBRARY_PATH="$PWD/../activity-ui-final/.tmp/browser-libs/usr/lib/aarch64-linux-gnu:$PWD/../activity-ui-final/.tmp/browser-libs/lib/aarch64-linux-gnu"
export FONTCONFIG_FILE="$PWD/../activity-ui-final/.tmp/fonts.conf"
node --import tsx scripts/activity-database-browser.mjs
node scripts/activity-panels-browser.mjs
npm run typecheck
npm run build
npx vitest run tests/activity-panels.test.tsx tests/direct-integration.test.ts tests/direct-activities.test.ts tests/native-activity-ingress.test.ts tests/activities-server.test.ts --maxWorkers 1
node --import tsx --test test/adapters.test.ts test/acp-adapter.test.ts
git diff --check
```

On a normal Playwright host, install its Chromium dependencies/fonts instead of using these worker-specific paths. No provider credentials or paid calls were used. Comprehensive suites remain root's responsibility.

## Integration blockers and scope

ACP integration scope is Pi, Codex, Claude Code and OpenCode; existing direct/API support remains. At reviewed base `2daa6a4`, `docs/ACP.md` still points to a Gemini live gate. Root must integrate/reconcile the separately prepared `origin/feat/acp-scope-pi-codex-claude-opencode` documentation/adapter work before final approval; this worker has not cherry-picked it. Treat earlier Gemini evidence as historical and outside the requested acceptance scope. A generic executable entry point does not certify arbitrary ACP agents. This UI fix does not alter direct/API routes.

No consolidated PR existed for `feat/shared-agent-activities-acp` when checked with `gh pr list`. Final approval is withheld until the actual PR head, required packet gates and root's comprehensive results are available. Missing live-agent evidence must remain explicit rather than being counted as a fixture pass.
