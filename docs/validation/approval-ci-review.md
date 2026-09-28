# PR #17 approval journey CI follow-up

Branch `fix/pr17-approval-journey` starts at `4ff12d18a20b83d1ad9f04b42f5e66d701fb3e33`, whose parent is PR head `df9a9143de3cce8b91624a141b64964b6d76e101`. Root owns integration and comprehensive suites.

## Current failure and diagnosis

Fetched PR status and `gh run view 36349910131 --log-failed`. [verify job](https://github.com/j-asefa/loop/actions/runs/36349910131/job/108706446373) failed in Chromium `npm run smoke:journey` at `scripts/approval-journey.mjs:19`: expected `@journey-agent`; actual approval identity and message both contained `@cherryjourney-agent`. Mobile, containers and native-contract jobs passed. WebKit journey was not reached by this failed verify job.

The unmodified local Chromium journey at `4ff12d18` passed all 17 summaries, demonstrating that the current approval failure is intermittent. The form fetches a suggested name asynchronously; Playwright fill selects the input and then inserts text in a separate browser protocol operation. A suggestion completing between those operations moves the insertion point after the suggestion. `CreateAgent` already guards against suggestions replacing user edits after `onChange`; the approval renders the actual saved identity correctly.

Controlled reproduction used the real creation UI and a held `/api/agents/suggest-name` response with `{name: "cherry"}`. Select the initially empty name field, release the suggestion, wait for `cherry`, then insert `journey-agent`: the resulting value is exactly `cherryjourney-agent`. Filling after suggestion settlement yields exactly `journey-agent`. This deliberately schedules the two phases of fill; it is not a claim that the full unmodified journey failed locally. The installed Playwright `_fill` implementation confirms the separate injected selection and `keyboard.insertText` phases.

## Change

The initial journey fixture now waits for the name-loading placeholder to settle before filling, then asserts the exact field value and the successful creation response's exact saved name. It fails at creation if fixture identity is wrong. Approval identity, duplicate-decision, stale-request, rejection, cross-user and public/private trace checks remain unchanged. No production safety code is relaxed.

## Evidence and reproduction

[evidence/approval-ci](evidence/approval-ci) contains the CI excerpt, baseline journey, controlled race output and the standalone diagnostic source. To repeat the diagnostic, copy `name-race-repro.mjs.txt` to `scripts/approval-name-race-repro.mjs`, run it with Node from the repository root after building, then remove the temporary copy. It uses the existing deterministic server, worker and broker fixtures; no paid provider calls.

Browser runtime setup on this worker:

```sh
export LD_LIBRARY_PATH="$PWD/../activity-ui-final/.tmp/browser-libs/usr/lib/aarch64-linux-gnu:$PWD/../activity-ui-final/.tmp/browser-libs/lib/aarch64-linux-gnu"
export FONTCONFIG_FILE="$PWD/../activity-ui-final/.tmp/fonts.conf"
npm run build
npm run smoke:journey
LOOP_BROWSER=webkit npm run smoke:journey
```

## Validation results

- `npm run build`: exit 0 (TypeScript, Vite, service worker and CLI); existing chunk-size warning.
- Baseline `npm run smoke:journey` at `4ff12d18`: exit 0, all 17 summaries.
- Controlled name-race reproduction: exit 0, exact concatenated-name reproduction and synchronized-entry check passed.
- Patched `npm run smoke:journey`: exit 0, all 17 summaries, including approval retries/duplicate decisions/stale requests, trace privacy and cross-user denials.
- `LOOP_BROWSER=webkit npm run smoke:journey`: exit 1 before browser launch; Playwright reports missing WebKit host libraries (including GStreamer, ICU 72, libxml2 and libsoup). No WebKit assertions ran. Root/CI must complete this check on a host with its browser dependencies installed.
- `git diff --check`: passed.

 No merge, deployment or final GitHub approval was performed. Archer's security fix, root's combined-suite validation and final approval remain separate gates.
