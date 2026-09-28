# Deterministic connection and reconnect coverage for PR #17

Base: `origin/feat/shared-agent-activities-acp` at `0d460bbc86f32f8520c3a55f6bde50d7a3de42fe`. Isolated worktree: `acp-deterministic-browser`; branch: `test/acp-deterministic-browser`.

## Implemented and exercised

`npm run test:browser:acp` runs real Chromium against the production paired workspace (WorkspaceHost, HTTP routes, SQLite, worker, native-session host and WebSocket replay). The UI creates agents with both the existing direct Codex connection and the ACP connection present. It selects each provider/account explicitly, submits through the UI, and checks persisted agent/run connection IDs and the resulting session harness. A direct follow-up retains its native ID and generation. ACP retains both across reconnects.

The local subprocess peers are `test/harness.mjs` (existing direct Codex fixture) and `test/fixtures/browser-acp.mjs` (ACP JSON-RPC fixture). No browser route interception, canned application API responses, synthetic workspace-change events, reload, provider credentials or model calls are used. The sole transport intervention terminates server-side WebSockets and rejects reconnections until the fixture has emitted and persisted progress. HTTP remains available, as in a WebSocket-specific outage.

At **1280×844 desktop** and **390×844 phone**:

- Pair through the real UI; choose direct and ACP connections through the creation form.
- Keep a pending approval and unsent draft in the same browser document while the socket is disconnected mid-run.
- Emit plan/tool updates in the ACP subprocess during disconnection; verify persisted events, zero frames delivered during the cut, and replay of every missed event from the browser's original epoch/cursor after reconnect. Later normal projection events may also arrive.
- Assert an unchanged document marker, zero main-frame navigations during recovery, unchanged session identity/generation, one rendered plan/tool/approval and no duplicate replay event IDs.
- Click the approval in the UI, resend the identical HTTP receipt through the authenticated browser, then reconnect again. Assert one actual subprocess prompt and decision, two unchanged message records, one run/dispatch/decision, four unchanged activity record keys, completed plan/tool UI, and no resurfaced pending approval.
- Exercise production failures for a missing desktop registration and an executable removed after registration. Assert visible setup guidance and failed runs; a missing registration creates no session binding.

The harness audits actual JSON-RPC decisions rather than inferring delivery from a successful HTTP response. The reconnect test observes real frames; periodic UI polling is left intact but cannot satisfy the replay assertions.

## Production defects fixed

1. The database provider CHECK omitted `acp`; enabling ACP on a fresh database failed before the browser started. [before.log](evidence/deterministic-browser/before.log) records the failure. Migration 031 rebuilds the constrained table while preserving both inbound reference types (agent connections and embedding preferences), with foreign keys enabled. A populated pre-031 migration regression checks all affected rows, native bindings, integrity, foreign keys and rejection of unknown providers.
2. The creation provider picker omitted ACP and its badge fell back to “Loop”. ACP is now an explicit native provider choice with the label “ACP agent”.
3. ACP startup errors became a generic worker failure, losing setup instructions. The native-session boundary now provides fixed, actionable guidance without exposing arbitrary process/SDK error text.

## Commands and results

Node `v24.21.0`; Chromium `153.0.8010.12` (Playwright Chromium 1243, ARM64). Dependencies reused from the prior checkout via an untracked `node_modules` symlink. The local browser needs these pre-existing runtime libraries/fonts:

```sh
export LD_LIBRARY_PATH="$PWD/../activity-ui-final/.tmp/browser-libs/usr/lib/aarch64-linux-gnu:$PWD/../activity-ui-final/.tmp/browser-libs/lib/aarch64-linux-gnu"
export FONTCONFIG_FILE="$PWD/../activity-ui-final/.tmp/fonts.conf"
npm run build
npm run typecheck
npm run test:browser:acp
npx vitest run tests/acp-connection-migration.test.ts tests/startup.test.ts tests/runtime-migration.test.ts tests/activities-integration.test.ts tests/activity-panels.test.tsx tests/direct-integration.test.ts tests/native-activity-ingress.test.ts --maxWorkers 1
node --import tsx --test test/acp-adapter.test.ts test/adapters.test.ts
node --import tsx scripts/activity-database-browser.mjs
git diff --check
```

On a standard Playwright host, install Chromium and its runtime dependencies instead of using these worker-specific paths. Build before running the new script: it intentionally exercises the compiled paired application.

| Check | Result |
| --- | --- |
| Build (includes TypeScript) | Passed |
| Standalone typecheck | Passed |
| New full-stack Chromium journey | Passed, both viewports |
| Focused Vitest suite | 37/37 passed across 7 files |
| ACP and direct subprocess adapter suite | 19/19 passed |
| Existing SQLite activity browser journey | Passed, both viewports |
| Whitespace check | Passed |

Machine-readable replay/cursor/count evidence is in [results.json](evidence/deterministic-browser/results.json). Full command logs and twelve selection, pending-approval, completion and setup-error screenshots are in [evidence/deterministic-browser](evidence/deterministic-browser). Intermediate driver iterations corrected accessible-label selectors, hidden trace text selectors, a fixture session-ID collision across viewports, and allowance for normal later projection events; the final complete run passed. The earlier missing-executable assertion exposed the generic error described above.

## Scope and remaining gate

Consulted `scripts/activity-database-browser.mjs`, `scripts/companion-browser-smoke.mjs`, `docs/validation/acp-final.md`, `docs/validation/acp-ui-combined-review.md` and PR #17's description. The requested `deliverables/loop-acp-astra/04-VALIDATION.md` is absent from the checkout and all existing workspace trees; it could not be read.

This completes deterministic browser coverage, not the separate live ACP gate. Authenticated real-agent prompt/cancel/approval/workspace-tool/session-load validation and final combined-head approval remain separate. No merge or deployment was performed, and these targeted results do not claim a comprehensive-suite or final PR approval.
