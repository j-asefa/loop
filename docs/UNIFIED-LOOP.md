# One Loop application

The `loop` repository owns both deployment profiles. There is one React application, one set of workspace routes and domain services, and one migration directory. The CLI is an entrypoint into that application, not a vendored copy of a server.

## Start a deployment

| Profile | Source checkout | Built/installed distribution |
| --- | --- | --- |
| Server, separate API and worker | `npm run setup && node --env-file=.env scripts/serve.mjs` | `node --env-file=.env dist/cli.js server`, or `loop server` with environment configured |
| Companion, foreground local host | `npm run build && node dist/cli.js codex --local-only` | `loop codex --local-only` |

Replace `codex` with `claude`, `pi` or `opencode`. Sign in using the provider's native CLI first. `--billing existing` explicitly keeps existing provider configuration; subscription mode validates subscription authentication and refuses API fallback. Run `loop --help` for pairing, device revocation, status, project directories, session handoff and tunnel options.

Server configuration continues to use `.env`/environment, `LOOP_DATA_DIR`, the existing authentication settings, encryption key, and configured runtime hosts. `loop server` starts the application and its worker together; Docker Compose retains supervised separate API and worker processes. `npm start` starts only the API, and `npm run worker` starts only the worker.

Companion startup selects `LOOP_PROFILE=companion` before loading services. It uses `LOOP_HOME/workspace` (default `~/.local/state/loop/workspace`) and generates a private encryption key there. The host holds an exclusive workspace lock, owns the worker and native subprocesses, and authorizes every workspace request using device cookies, exact host/origin checks and CSRF tokens. A bare server entrypoint rejects the companion profile. A standalone companion worker is also rejected.

A data directory records its profile and refuses startup under another profile. Use separate directories for separate deployments. This release targets fresh databases; no backwards-compatibility guarantee is made. The imported explicit CLI session import utility is not a general database upgrade promise.

## Execution and UI

Connections select execution through their metadata. Managed API and server subscription connections retain the existing execution path. Native connections route to durable native sessions before entering Loop's managed model/tool loop. The native binding retains its original conversation, directory and provider session. Native history is authoritative; Loop stores a display projection.

Managed runs retain per-agent serialization. Native runs allow independent conversations to run concurrently while serializing each conversation. Native dispatch records prevent uncertain prompts from being replayed automatically. Approvals resume the owning native run without placing it back in the managed queue. The companion host owns cancellation, tool tokens and shutdown; unrelated native conversations remain active.

`GET /api/capabilities` advertises the deployment's authentication and execution features before the UI mounts. The shared app selects pairing or account sign-in, local device controls or remote machine controls, local project paths, native history and native connection panels accordingly. Server uses bounded event polling; companion uses replayable WebSocket events and a polling fallback. Both consume the same workspace views and compiled assets.

Server command-based MCP tools use the existing remote runtime transport. Companion command-based tools use local SDK-owned subprocesses. Native harnesses receive a private, generation-bound MCP bridge to authorized Loop tools. Native credentials and native history remain with their respective harnesses.

## Deliberate boundaries

The adapters implement the source PR's actual transports: Codex App Server, Claude stream-json, Pi RPC and OpenCode HTTP. This is an ACP-style UI experience, not an implementation of the Agent Client Protocol wire standard. A literal ACP adapter is not included.

There is no cloud-to-desktop execution bridge and no multi-user native host. A tunnel exposes a local companion UI; it does not relocate execution. The companion can combine local harness and explicit API connections. Server runtime-host management remains in the server profile. Importing arbitrary native accounts into a multi-user server or changing the backend of an existing conversation is not supported.

## Validation

- `npm run build`: typecheck, one Vite UI, service worker and compiled server/CLI modules.
- `npm test`: server domain, authentication, managed runtime, workflow, MCP and regression suites.
- `npm run test:native`: protocol fixtures, lifecycle ownership, pairing/security, concurrent conversations, native tools and approvals, cancellation, history, reconnect and restart recovery.
- `npm run smoke:browser` and `npm run smoke:journey`: existing server browser journeys.
- `npm run smoke:companion`: paired mobile browser journey with native fixture subprocesses.
- `npm run smoke:package`: packs and installs into a clean directory, then verifies CLI startup, pairing, API, WebSocket and stop/restart behavior without another checkout.

CI runs server and companion browser journeys in Chromium and WebKit, package installation, and the existing Docker deployment smoke tests. Fixtures verify our protocol handling and lifecycle behavior; they cannot establish live account availability, billing, or compatibility with every installed provider version. A real provider/account and physical-device acceptance check remains distinct from automated fixture validation.
