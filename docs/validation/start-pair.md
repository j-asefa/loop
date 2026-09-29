# Start/pair verification

Base: `9c0339f` (main). This change extends the existing companion path rather than adding a second runtime router. Managed HAPI preferences and existing server commands remain supported. See [ownership and product behavior](../companion/START-PAIR.md).

## Passing checks

- `npm run build`: TypeScript, client, service worker and CLI build pass. Existing large-chunk warnings remain.
- `node --import tsx --test --test-concurrency=1 test/host.test.ts test/lifecycle.test.ts test/local-runtime.test.ts test/mobile-connection.test.ts test/start-runtimes.test.ts test/workspace.test.ts`: **30 passing tests**. Run with workspace-local `TMPDIR` and `GOMAXPROCS=2` in constrained workers.
- New CLI test `loop start pairs without enabling a harness, reuses the host and survives restart` passed in the native suite, as did existing CLI daemon startup, crash/stop/ownership tests. The full native suite did not finish cleanly; see below.
- `node scripts/start-pair-browser.mjs`: **passed**, Chromium at 390×844. Actual paired HTTP gateway and React UI, fixture Codex executable: pair → enable runtime without CLI launch → choose project → create and finish native task. The script needs Playwright's browser/system libraries and fonts. This worker used local library/font paths; no production dependencies were changed.
- **Live Codex 0.157.0:** paired HTTP API enablement in subscription mode, initial task, duplicate creation receipt, and follow-up completed with the persisted native session. Initial attempt failed during enablement under resource pressure; account probe and complete journey passed on retry. Live check used an isolated temporary workspace and simple text-only prompts, not provider fixtures.
- Four-runtime API fixture test checks Claude Code, Codex, Pi and OpenCode dispatch, native identities, safe create retries, subsequent turns, billing conflict rejection and no secret disclosure. Fixtures are not live provider evidence.

## Acceptance mapping

| Contract | Evidence / limit |
|---|---|
| A1 initial start/pair | CLI test, paired browser journey. No physical phone QR scan performed. |
| A2 duplicate/concurrent starts | CLI reuse test and existing exclusive host-lock/stale-owner tests. Lock contenders fail safely with retry guidance. |
| A3 four runtimes | Four real subprocess protocol fixtures through paired app APIs; live Codex only. |
| A4 operate session | Workspace tests for streaming/replay, isolated approvals, follow-up and cancellation; adapter fixtures; live Codex follow-up. |
| A5 restart | CLI bearer trust/identity after restart; workspace recovery never replays prompts. |
| A6 changed address | Existing mobile-connection and host pairing tests. Real public tunnel recreation not exercised. |
| A7 access/pairing | Host expiry, replay, origin, CSRF and revocation tests; enablement rejects unbound project and executable input. |
| A8 setup failure | Host version discovery, explicit unknown authentication, preserved billing, safe failed-enable guidance. |
| A9 retries/disconnect | Creation receipt retry yields one agent/run per runtime; workspace recovery and decision isolation. |
| A10 compatibility | Existing CLI shortcut tests, local-runtime unit tests and unchanged managed preferences path. Full Docker/mTLS deployment not certified by this run. |
| A11 pair again | CLI issues another code without revoking bearer trust and rejects stopped pairing with start guidance. |
| A12 startup failures | Existing CLI failure/ownership/stale-state checks, lifecycle tests and named-tunnel fixtures. Real tunnel outage not exercised. |

## Remaining verification and product limits

- Installed Claude Code is **2.1.280**, but Loop's existing discovery accepts **2.1.282**. Pi and OpenCode are absent. Install the validated versions, authenticate each on the execution host, and repeat app-created tasks, supported approvals, cancellation and restart recovery. No installation or authentication was changed for this check.
- Browser simulation is not an iOS/Android physical-device check. Verify camera scanning, secure credential storage and tunnel address repair on a device.
- Companion mobile currently saves one computer connection. Users choose a different computer by switching that connection; this PR does not introduce a simultaneous multi-computer registry.
- Existing managed HAPI preferences are reused. `loop start` is not an importer for arbitrary external HAPI servers; server/Compose deployments retain existing entry points.
- Full `npm test` and `npm run test:native` attempts were **not green**. This worker has a 256-process/thread limit and a no-execute `/tmp`; failures included `EACCES`, esbuild `EAGAIN`/`newosproc`, and timeouts. Runs were stopped and focused tests rerun with lower concurrency and executable temporary storage. Two runtime-contract steering failures also reproduce on unchanged `9c0339f` with workspace-local temporary storage. Other full-suite failures were not individually baseline-triaged; do not treat all of them as proven pre-existing. A clean CI/full-suite run remains necessary before merging.

No deployment or merge was performed.
