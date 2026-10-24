# Start once, use installed harnesses

Run `loop` in your project directory. It starts one workspace in the background and prints a two-minute, single-use pairing QR and link. Scan with your phone's camera or open it in a browser. Pairing is available while installed harnesses are checked independently.

Loop connects supported Codex, Claude Code, Pi and OpenCode installations through their direct adapters. In **New agent**, choose a connected account, model, effort and project. Use **Settings → Provider connections** to sign in, refresh models or enable another harness. See [harnesses](../harnesses.md) for billing, team handoffs and upgrade recovery.

`loop start --providers codex,claude` limits discovery; the default is all supported installed harnesses. Saved provider choices and projects are reused. Explicit `loop codex|claude|pi|opencode|gemini|muse|grok|acp` commands can register custom paths and native options in the same workspace.

`loop pair` makes a fresh code without revoking existing devices. `loop status --json` distinguishes workspace readiness from verified execution availability. `loop logs --follow` shows diagnostics; `loop stop` shuts down. `--foreground` stays attached to the terminal; `--local-only` serves a desktop workspace without a tunnel.

The CLI owns startup and its process identity lock. `WorkspaceHost` owns the workspace, pairing and private tool bridge; native adapters own harness processes and session context. Loop persists dispatch receipts and never automatically replays an uncertain send.

The [Docker companion](../pairing.md#docker-companion) also supports pairing. Linking a [local Docker server](../pairing.md#unified-agents-and-feed) aggregates its agents without moving its data.
