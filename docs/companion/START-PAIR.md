# Start once, use installed harnesses through HAPI

Run `loop` in your project directory. It starts the workspace in the background and prints a two-minute, single-use pairing QR and link. Scan with your phone's camera or open the link in a browser. The workspace remains available while HAPI prepares.

Loop discovers supported installed harnesses and verifies their existing native account through HAPI. In **New agent**, choose a connected runtime, model, effort and project, then enter an initial prompt. If account verification fails, use **Settings → Execution environments** to inspect sign-in and retry. See [harnesses](../harnesses.md) for discovery, billing and model catalogs.

`loop pair` shows a fresh code for the running workspace. It replaces an unused code, not existing device trust. `loop status --json` distinguishes workspace readiness from HAPI setup readiness; a saved connection is not a fresh sign-in guarantee. Use `loop logs --follow` for setup diagnostics and `loop stop` for shutdown. `--foreground` keeps the process attached to the terminal; `--local-only` is for desktop testing.

`loop start --providers codex,claude --execution native` limits selected runtimes. Saved provider/execution choices are reused. There are no harness-specific commands or direct-execution fallback. Setup failures leave the workspace available and harness execution unavailable until HAPI is repaired and restarted.

Restarting retains workspace data and paired-device credentials. A Quick Tunnel can change address: run `loop pair`, scan with your phone and add the new page to your home screen. See [pairing and recovery](../pairing.md).

## Ownership

The CLI owns startup and the process identity lock. `WorkspaceHost` owns the Express workspace and pairing gateway; `LocalRuntime` provisions HAPI and its runner. Discovery and enablement are runner-scoped and never accept executable paths from the browser. HAPI owns harness processes, context and sessions. Loop records dispatch intent before external work and never automatically replays an uncertain send.

Older direct conversations keep their history but cannot run. Reconnect their agents to HAPI and start new conversations. This does not take over live terminal sessions or copy credentials. Existing HAPI conversations retain their immutable session bindings.

The separate [Docker companion](../pairing.md#docker-companion) supports pairing. Linking a [local Docker server](../pairing.md#unified-agents-and-feed) does not move its data. Local startup does not import arbitrary external HAPI deployments.

See [development](../development.md) for checks. Deterministic fixtures verify Loop's boundaries; they do not certify authenticated provider or physical-phone behavior.
