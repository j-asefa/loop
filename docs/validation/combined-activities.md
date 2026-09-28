# Combined native activity validation

Base: `ceade1b` on `origin/feat/shared-agent-activities-acp`, integrating UI, Aurora ingress and Archer ACP. Work is isolated in `activity-combined-validation` on `fix/combined-activity-ingress-validation`.

## Review findings and fixes

1. **Settings revision alone did not authorize the current process.** Replacement adapters restart their revision counters, so a stale tab could submit the same revision to a different generation. The settings PATCH now requires the generation returned by GET. NativeSessions checks map identity, closed state and the database binding after readiness and after the adapter returns. Stale writes fail with 409 before dispatch; responses from replaced sessions cannot confirm current settings. Regression tests cover replacement during readiness and during the write. Cached older clients must reload before writing; omission of generation is intentionally rejected.
2. **Controls reads could expose a closed or obsolete adapter.** The settings GET now uses only a live adapter matching the persisted binding generation. Otherwise it reports disconnected with undiscovered capabilities, allowing the client to show recorded settings without write authority.
3. **Persisted settings and capabilities were selected independently.** Conversation now pairs them by transport, harness and generation. The fallback verifies that pairing and remains read-only. A failed settings load without a durable snapshot clears prior live controls instead of retaining enabled stale inputs.
4. **The previous browser gate bypassed native ingress.** The fixture no longer imports or calls `applyActivity` or `setActivityCapabilities`. Every activity and capability comes through `NativeSessions.event`; the pending approval also enters through its native request event. SQLite assertions verify server-owned generation, pending approval state, pagination and content-free `activity.updated` signals.

The review used the shared contract in `docs/architecture/AGENT-ACTIVITIES.md`, direct integration notes, and the merged production UI/direct adapters. Existing documentation contains historical pending-wiring statements; the executed checks here supersede those statements for this combined base. Direct adapter extraction, instance-local ordering, replay identity, next-turn confirmation, live control rejection, dependent choices and catalog replacement were inspected and covered by focused tests. No additional direct-adapter production fix was established by this review. ACP protocol and process tests ran against the merged implementation.

## Executed checks

- `npm run build`: passed (TypeScript, Vite, service worker and CLI); existing large-chunk warning.
- Focused Vitest: **67 passed across 8 files** — direct integration/extraction, shared reducer, server/native/API integration, panels and native ingress.
- `node --import tsx --test test/adapters.test.ts test/acp-adapter.test.ts`: **18 passed**, including actual fixture subprocesses for all four direct adapters and ACP.
- Database browser: **390×844 and 1280×844**. Production Conversation, NativeHistory, controls, Express routers and migrated SQLite with an injected deterministic in-process adapter.
- `git diff --check`: passed.

Browser assertions cover live updates, completed reload, managed history, pending approval reload, active-turn settings rejection before adapter dispatch, requested/confirmed separation, adapter rejection, dependent-option removal, catalog removal, legacy/durable broker de-duplication, disconnected read-only settings, replacement generation and revision reset, stale-generation write rejection, a never-started session's production error, injected connection failure, hostile text escaping, viewport bounds and output scroll/follow behavior. More than 500 capability records, emitted through native ingress using synthetic trusted harness bindings, force real endpoint pagination. The real fixture harness is restored before publishing settings and turn activities.

Run on a standard Playwright host:

```sh
node --import tsx scripts/activity-database-browser.mjs
```

An intermediate rerun hit a Chromium renderer crash during the final setup-error navigation. The fixture now releases its navigation-heavy browser context before the setup checks and disables shared-memory use; the final complete run passed. No production failure was established from that crash.

This worker reuses ignored ARM Chromium libraries and font configuration from the earlier checkout via `LD_LIBRARY_PATH` and `FONTCONFIG_FILE`; neither is committed. Screenshots are in `evidence/combined-activities/`.

## Boundaries

The driver seeds the conversation/run and uses deterministic adapter responses; it never substitutes production read responses. Final run completion is set by the driver after ingress display updates. Workspace-change notifications are explicitly dispatched by the browser driver; this is not a full App/WebSocket/authentication-stack browser gate. The fixture tests setup absence and injected connection errors, not real external login or provider availability. External native-history subprocess discovery is covered by focused tests, while the browser checks managed database history.

No paid calls, deployment, merge, additional PR or final unanimous approval. The actual cohesive PR head still requires the requested final review after integration. This is focused combined validation, not a claim that every unrelated repository test passes.
