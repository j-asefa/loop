# Final activity UI integration

Historical report for `d8d0d55`; its pending-ingress statements describe that base only. See [combined validation](combined-activities.md) for integrated ingress checks and [combined UI review](acp-ui-combined-review.md) for the review of `2daa6a4`.

Branch `feat/activity-ui-final` starts at remote `d8d0d55cd636af1a3cf4bb3612c1bde013e51bf9`. It is an independent checkout. No shared-branch commit or push is part of this work.

## Implemented contract

Production `Conversation` now consumes Aurora's actual `GET /api/conversations/:id/activities`: `{version, items: [{key, kind, run, sequence, record}], cursor, more}`. The ordinary conversation endpoint does not include activities. The client follows all pages, merges incremental snapshots by key/sequence, preserves earlier runs, and queues a refresh that arrives during a fetch. Activities render once beside the run's final loaded assistant message (or its prompt before an answer). Session records render separately. Metadata projections are a fallback, not a duplicate of durable records.

Legacy broker traces disappear when the corresponding durable record arrives, including on a later page/refresh. Full loads now include legacy traces even when durable activity pagination is necessary; previously those traces were omitted from every page. De-duplication is scoped to the run and explicit trace link.

Native history accepts the server's `{key, kind, record}` envelopes and ignores stale selection responses. Managed native history opens the saved conversation. Recorded settings/capabilities remain inspectable when the native session is disconnected, with mutation disabled. A supported live response with an empty option list stays empty, rather than resurrecting recorded options. Live settings/catalogs retain the existing production routes, revisions, confirmation/rejection behavior and dependent-choice removal.

All four direct adapters now assign instance-local producer sequence numbers. Codex append chunks receive stable per-output indices so replaying an emitted chunk does not duplicate output. Codex checks thread and turn identity before producing rich events. Trusted generation changes reset settings/catalog producer revisions and obsolete options in the shared reducer. Generation authority remains server-owned; adapters do not choose the owning run or conversation. Upstream output truncation is displayed.

## Executed validation (2026-09-27, Node 24.21.0)

- `npm run build`: PASS, including TypeScript, Vite, service worker and CLI. Existing Vite large-chunk warning remains.
- `npx vitest run tests/direct-integration.test.ts tests/direct-activities.test.ts tests/activities-integration.test.ts tests/activities-server.test.ts tests/activities-native.test.ts tests/agent-activities.test.ts tests/activity-panels.test.tsx --maxWorkers 1`: **62 passed, 7 files**.
- `node --import tsx --test test/adapters.test.ts test/acp-adapter.test.ts`: **14 passed**. Includes real fixture subprocess framing for direct adapters and deterministic ACP protocol tests.
- `node --import tsx scripts/activity-database-browser.mjs`: PASS at **390×844 and 1280×844**. Production Express `core`, `companion`, and `activityRoutes`, actual SQLite migrations/persistence, production Conversation/NativeHistory/settings/catalog UI. No Playwright route interception or canned conversation/activity/settings/catalog responses.
- `git diff --check`: PASS.

The database browser script covers:

- More than 500 persisted activity entries, forcing endpoint pagination; live updates and completed-state reload.
- A persisted pending native decision surviving reload.
- Active-turn settings writes rejected through `NativeSessions.setSetting` before reaching the adapter.
- Requested versus confirmed values, deterministic adapter rejection, dependent option removal, catalog removal.
- Legacy broker trace followed by its durable activity: exactly one card, including after reload.
- Managed native history reopening the completed SQLite conversation.
- Disconnected recorded settings remaining visible and disabled.
- Hostile HTML-looking paths/text remaining literal, viewport width bounds, command-output scrolling/follow control.

The script injects a deterministic in-process adapter into NativeSessions and uses `DirectControls` for setting responses. It seeds a real run/message/decision and publishes activities through `applyActivity`; its test-driver endpoint mutates SQLite instead of substituting production reads. Authentication middleware and external Codex history subprocess discovery are outside this browser gate. External history projection is covered by the focused integration tests, not claimed as a database browser result.

This worker needed locally staged Debian Chromium dependencies and fonts (untracked):

```sh
LD_LIBRARY_PATH="$PWD/.tmp/browser-libs/usr/lib/aarch64-linux-gnu:$PWD/.tmp/browser-libs/lib/aarch64-linux-gnu" \
FONTCONFIG_FILE="$PWD/.tmp/fonts.conf" \
node --import tsx scripts/activity-database-browser.mjs
```

## Remaining combined-branch gates

Aurora's actual NativeSessions activity ingress, safe `activity.updated` refresh wiring and trusted generation scoping were still pending at remote `d8d0d55` when checked. That base emits `native.event` for adapter activities without calling persistence from the NativeSessions event handler. The browser gate above does **not** prove that unfinished ingress; it proves the real persistence/router/client path once activities are ingested. Re-run combined native live/reload checks after Aurora's merge, and reconcile the shared reducer generation-reset change if Aurora changes the same block.

No paid real-agent/ACP auth-resume execution, full authentication-stack browser gate, comprehensive suite rerun, PR review, merge or deployment is claimed. The prior branch's broad-suite failures are not reclassified by these focused passes. Final combined PR review remains required.
