# Start once, choose runtimes in the app

Run `loop start` in your project directory. It starts the workspace in the background and prints a two-minute, single-use pairing QR and link. Scan with the Loop app, or open the link in a browser. Choose **New agent → Choose or enable a runtime on this computer**, select the bound project directory and billing policy, and enable Codex, Claude Code, Pi or OpenCode. Then choose that connection/model and project and enter an initial prompt to create and start the agent. Leaving the prompt empty creates an idle agent.

Install and authenticate the desired harness on the execution computer first. Discovery runs on that computer and validates the supported executable version. Installed does not mean authenticated: enablement checks the adapter's account/billing contract. Existing configuration is an explicit choice and may use API credits; subscription mode never falls back. Enabled runtimes preserve their billing choice. Settings → Connected harnesses offers the same setup controls.

`loop pair` displays a fresh code for the running instance; it does not start services or agents. It supersedes an unused pairing code, not already paired devices. If stopped, run `loop start`. `loop status --json` distinguishes server readiness from whether any native harness is registered. Registration is not a fresh authentication guarantee. Use `loop logs` for diagnostics and `loop stop` for shutdown. `--foreground` keeps startup attached to the terminal. `--local-only` is for desktop testing; mobile pairing requires HTTPS. `--public-url` uses your externally configured HTTPS tunnel; named-tunnel options are unchanged.

Restarting retains workspace data and paired-device credentials. A Quick Tunnel can change address: run `loop pair` and scan inside the app to replace its saved connection address. The current native shell has one saved computer connection, not a multi-computer directory. Switching that connection is how users choose a different companion computer. There is no new discovery service or cross-runtime conversation migration.

## Ownership and compatibility

- `src/cli.ts` owns startup, preferences and daemon launch; `lifecycle.ts` owns the process-identity lock. Concurrent starts cannot acquire a second host lock; the loser receives retry guidance. It does not stop the winner.
- `WorkspaceHost` owns the existing Express workspace, worker and native tool bridge. Runtime-neutral startup binds the initial project without probing or launching a harness.
- `Host` owns pairing, persistent device trust, transport origin, local control authentication and browser CSRF. New discovery/enable endpoints are behind the same gateway.
- `companion-routes.ts` performs host-side discovery. App enablement accepts a bound project and explicit billing policy, never arbitrary executable arguments. Saved desktop executable overrides remain authoritative.
- `NativeSessions` owns registration, account probing and native sessions. Existing `CreateAgent`, agent-creation receipts, queue and adapters own task dispatch, retry deduplication, native IDs, streaming, approvals and cancellation. No second task queue or agent loop was added.
- Existing managed laptop preferences (providers/execution) cause `loop start` to reuse that managed HAPI topology. Bare `loop` is an alias for `loop start`; pass provider and execution options to configure managed native/Docker setup. Existing server/Compose deployments retain their documented commands; `loop start` is the companion/laptop entry point, not an importer of arbitrary external HAPI deployments.
- `loop codex`, `loop claude`, `loop pi`, `loop opencode` and `loop acp` remain terminal shortcuts. They are not prerequisites for app enablement. Existing companion registrations survive runtime-neutral restarts.

The app web view serves the same React UI as the browser. No React Native API changes are needed. The current paired companion is the execution computer; managed HAPI connections retain their environment selector. OpenCode and Claude subscription restrictions remain those of the existing adapters. No new claim of unsupported authentication, permissions or recovery is made.

## Verification

The new tests exercise runtime-neutral CLI startup, reuse, stopped pairing guidance and bearer trust after restart, authenticated runtime discovery, executable-input rejection and billing preservation. A four-runtime fixture journey enables each adapter over the paired HTTP API, creates an initial task, retries creation with the same receipt, and sends a subsequent turn. These are simulated provider protocols, not authenticated provider acceptance.

Existing daemon, lock, tunnel, host, mobile-connection, adapter and workspace tests cover crash recovery, duplicate starts, pairing expiration/replay, address changes, cancellation and native decisions. See the PR for actual check results and remaining live prerequisites.
