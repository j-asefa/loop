# Loop CLI

One desktop command. One paired phone. Your agents in the original Loop workspace.

Run Codex, Pi, Claude Code or OpenCode on your computer and use Loop's Feed, Running, Projects, Search and Saved screens from your phone. Each conversation keeps a durable native session; the desktop harness runs its own agent loop, tools, instructions, skills and permissions. Loop hosts the UI and workspace services locally.

**Preview implementation.** Automated and mobile browser journeys use deterministic harness fixtures. Real signed-in provider tasks, public tunnel traffic and a physical iPhone remain release gates. Claude.ai subscriptions are blocked pending provider approval; OpenCode billing is unverified. See [validation and scope](../UNIFIED-LOOP.md#validation).

## Install from this repository

This package has not been published to npm. On macOS or Linux with Node **22.19+**:

```sh
git clone https://github.com/j-asefa/loop.git
cd loop
npm ci
npm run build
npm link
cd /path/to/your/project
loop codex
```

Install the supported native harness and sign in through its normal desktop command first. Loop neither installs nor upgrades your harness. `loop doctor` shows the required versions.

Scan the QR with your phone, select **Pair and open Loop**, then create named agents. Select the same project for several agents or bind another existing desktop directory in Projects. Each new conversation gets its own native session and can work concurrently. Switch conversations, answer native decisions in their owning conversation or Running, and cancel a task without stopping its siblings.

Keep the owning terminal and computer awake. Phone disconnection does not stop work. The host uses eight execution slots, allows waiting native decisions/delegations to release capacity, and caps active worker tasks at 32. Idle native processes are evicted after 60 seconds and resume through native session IDs.

A second invocation joins the running workspace:

```sh
loop pi
loop claude --billing existing
loop opencode --billing existing
loop codex                 # reuses the host and paired phone
loop pair                  # pair another device
loop status --json
loop devices
loop devices revoke DEVICE_ID
loop stop
```

`loop claude-code` is an alias for `loop claude`. Claude requires an explicitly configured API/provider account. `--billing existing` retains the selected native provider and can incur charges; it never means verified subscription usage.

## Native compatibility

| Harness     | Protocol / pinned version                          | Billing and limits                                                                                                                                                                    |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | App Server, 0.156.1                                | Subscription mode requires native ChatGPT login and the built-in OpenAI provider. Conflicting API/gateway configuration is rejected. Plan limits and enabled overage still apply.     |
| Pi          | RPC + process-local extension, 0.87.1              | Subscription mode requires native effective OAuth metadata and the provider's subscription declaration. Native extensions govern permissions; Loop does not invent a permission gate. |
| Claude Code | Bidirectional CLI stream JSON, 2.1.282             | Claude.ai login is blocked because approval for this third-party integration has not been established. Explicit API/provider mode is implemented.                                     |
| OpenCode    | Authenticated loopback server + local SSE, 1.18.32 | Explicit existing-provider mode only. Native metadata cannot establish subscription billing.                                                                                          |

No provider tokens are extracted or sent to the phone. Native settings are inherited. Model and extra instructions selected in Loop apply to **new** conversations; an existing native conversation retains its original directory and settings. Installed native skills/plugins remain available, with catalogs from supported native APIs. Terminal-only interfaces are not reproduced.

The native Codex history view discovers saved conversations across directories, reads supported history, and forks an external conversation into a new native thread. Managed saved conversations can receive follow-ups. Loop does not take over arbitrary live desktop/TUI processes. An explicit desktop handoff is available with `loop codex --resume NATIVE_ID` while the workspace and original session owner are stopped.

## Workspace features

The UI and local SQLite services are reused from `j-asefa/loop`: artifacts and versions, search, filing, imports, sharing, teams, bounded workflows, MCP tools, charts, diagrams and MCP Apps. Native tools connect to these services through a private local MCP bridge; Pi uses a process-local extension. Tool approval and provenance remain in Loop. MCP changes can require reopening an idle native conversation, especially Pi.

Workflows bound agent steps and elapsed native work. They cannot cap a native harness's internal model calls or output tokens. API connections retain their separate model/token budgets. Native turns can be interrupted, not paused mid-turn. Queued tasks can be paused.

Keyword search works locally without downloads. Semantic search uses an optional local embedding runtime/model; Search reports whether it is ready, disabled or unavailable. `npm ci --omit=optional` can install the runtime without semantic-search dependencies (building from source still needs the platform packages used by TypeScript/esbuild).

See [native adapter architecture](NATIVE-ADAPTERS.md) and [deployment profiles](../UNIFIED-LOOP.md).

## Connection and recovery

Loop downloads a pinned, hash-verified cloudflared helper and starts an account-free Quick Tunnel. HTTPS serves the UI and authenticated WSS carries workspace updates. OpenCode's SSE remains local; the public connection does not rely on SSE. Cloudflare terminates TLS, so this is not application-level end-to-end encryption.

Quick Tunnel URLs rotate after restart/reconnection. Pair again at the new origin; browser drafts and installed PWA data are origin-scoped. For a tunnel you manage, use `--public-url https://your-host.example` and point it at the loopback port printed by Loop. `--local-only` supports desktop testing. Never expose the private administration or native tool endpoints.

Pairing links expire after two minutes and can be redeemed once. A paired device can control agents and access the desktop through their granted native tools. Revoke lost devices with the CLI or Settings → This computer. Host restarts require pairing again in this preview.

Workspace state lives in `$LOOP_HOME/workspace`, defaulting to `~/.local/state/loop/workspace`. Stop Loop and back up the entire directory, including `loop.db` and `encryption-key`. Native history remains in the harness's own location. Unknown prompt/decision/tool outcomes are recorded and never silently retried; review partial work before an explicit follow-up.

Legacy per-project snapshots are backed up and migrated once without deleting the originals. An active legacy host blocks migration before work starts. Unreadable ownership records fail safely; inspect them after confirming that no Loop host remains. `loop uninstall` retains workspace/native data and explains package removal. Loop never rewrites the user's harness configuration.

## Development

```sh
npm run check
node scripts/package-smoke.mjs
npx playwright install --with-deps chromium webkit
node scripts/browser-smoke.mjs
LOOP_BROWSER=webkit node scripts/browser-smoke.mjs
```

Tests make no provider requests. The clean tarball journey validates installation, pairing, native fixture execution, repeated CLI invocation, restart persistence and retained data. The native implementation was incorporated from `j-asefa/loop-cli` PR #1 at `447fbc3ed5f60fae99907fac7a7249e66fab8734`; all maintained code now lives in this repository. Live acceptance is separate from automated fixture validation.
