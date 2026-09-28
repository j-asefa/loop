# Loop

Loop has one shared UI, database schema and workspace API, with two deployment profiles:

- **Server:** the existing Loop agent runtime, personal or multi-user authentication, API connections, subscription runtimes and remote runtime hosts.
- **Companion:** the same workspace over local Codex, Claude Code, Pi and OpenCode harnesses, with phone pairing, durable native sessions and an optional tunnel. Explicit API connections can also run Loop's managed agent runtime.

Build once with `npm ci && npm run build`. Run the existing server deployment with `npm run setup && node --env-file=.env scripts/serve.mjs`, or start the compiled all-in-one server with `node --env-file=.env dist/cli.js server` (`loop server` once installed). Start a companion with `node dist/cli.js codex --local-only` (substitute `claude`, `pi` or `opencode`; omit `--local-only` to open a Quick Tunnel); it shows a pairing code and then keeps running in the background until `loop stop`. Pair from the standalone [Loop app](mobile/README.md), which survives Quick Tunnel address changes: run `loop pair` and scan again from inside the app, with no reinstall. For a standalone installation, run `npm pack` and install the generated tarball; it provides the `loop` command. No sibling checkout is required.

For native **or Docker** agents behind one phone pairing, run `node dist/cli.js` / `loop`. Choose OpenAI / Anthropic and native / Docker / both on first launch. Existing Cloudflare named tunnels, persistent device trust, and optional startup at login are supported. See [laptop launcher setup](docs/specs/unified-runtime/01-OPERATIONS.md).


See [deployment profiles and architecture](docs/UNIFIED-LOOP.md) and [companion commands](docs/companion/CLI.md). This consolidation targets fresh data directories; it does not promise compatibility with prior Loop or loop-cli databases. Each database is bound to its deployment profile.



A phone-first, private agent workspace. Choose a connected account and model, give an agent a durable @name, and keep its conversations, work and sources in one searchable place.

Implemented: subscription connections through official Codex/Claude Code runtimes; optional OpenAI Responses and Anthropic Messages streaming adapters; importable ChatGPT/Claude history; durable ordered runs and approvals; Feed/Running/Search/Saved; project folders and reversible filing; bounded versioned multi-agent workflows; workspace-wide MCP connections; native chart snapshots and isolated MCP Apps; reviewed link sharing and an installable PWA shell.

September feedback adds local semantic search, generated avatars, compact composition, response links, feed-only archiving, native Mermaid diagrams, manager/worker teams with filtered feeds, a searchable 50-tool MCP catalog, JSON MCP installation and remote runtime machines. See the [report and verification](docs/feedback/REPORT.md) and [runtime/MCP setup](docs/feedback/RUNTIMES.md). The Pi.dev integration design is documented; its provider adapter is not yet shipped.

The composer supports file attachments and agent provider/model/effort settings. Conversations include public progress updates as well as final answers, with tool details kept separately. Teams can be deleted while preserving their agents and history. See [workspace controls](docs/feedback/WORKSPACE-CONTROLS.md).

**Saved** contains only cards you bookmark, with the same team and project filters as Feed. Profiles support retiring and restoring agents, and **Settings → Result notifications** enables phone alerts for new results. On iPhone, open Loop from its Home Screen icon before enabling notifications. See [Saved, retirement and notifications](docs/feedback/SAVED-NOTIFICATIONS.md).

Existing remote Codex installations can also connect directly through **Settings → Runtime machines → Codex app-server**. This reuses the machine's ChatGPT login and enables its native tools. Claude Code can use the new native host runner with the laptop's existing sign-in, files and tool configuration. See [direct app-server setup and Claude equivalents](docs/feedback/RUNTIMES.md#connect-directly-to-codex-app-server) for tunneling, authentication and current limits.

**Release status: draft.** Local tests and labeled fixture journeys pass. Live provider/OpenAI embedding/Datadog verification and an HTTPS deployment with actual iPhone installation remain blocked by external access. Subscription runtimes and sign-in flows are implemented; authenticated allowance usage still needs user sign-in verification. No public preview URL is claimed. See the [acceptance evidence](docs/loop-v0/EVIDENCE.md).

## Run with your subscriptions

Docker with Compose and Node.js 24 (for generating configuration):

```sh
node scripts/setup.mjs
docker compose up --build -d
```

No domain or Loop account is required. Open http://localhost:3000 directly into your personal workspace, then go to **Settings → Provider connections**. Choose **Add a provider** if you already have an account connected, then choose ChatGPT (Codex) or Claude (Claude Code). Keep **Subscription** selected and continue to the official provider sign-in flow. Then create an agent with that account and model. No provider API key is required. Plan limits and any extra-usage settings apply; Loop never falls back from a subscription connection to API billing.

Single-user mode is the default. An existing installation with one Loop account keeps that account's workspace, conversations and encrypted connections. Remote single-user access uses one authenticated gateway, with a private `LOOP_GATEWAY_TOKEN` shared between the proxy and Loop. For separate user accounts, set `LOOP_AUTH_MODE=multi-user`. See [access configuration](docs/loop-v0/DEPLOYMENT.md#workspace-access).

Without host Node, generate the configuration using `docker run --rm -v "$PWD:/setup" -w /setup node:24-bookworm-slim node scripts/setup.mjs` first. Setup preserves existing secrets and adds the private runtime token when missing.

The API and independent worker share persistent `loop-data`. Subscription credentials live in separate per-connection runtime volumes. Preserve `.env`, the database volume and runtime credential volumes across restarts. The runtime broker is private and alone has Docker control access. See [subscription setup and boundaries](docs/loop-v0/SUBSCRIPTIONS.md).

For API-only development without Docker: `npm ci`, `npm run setup`, `npm run build`, then `node --env-file=.env scripts/serve.mjs`. Subscriptions additionally need the supplied broker/runtime infrastructure or a paired native host / Codex app-server; Loop cannot run on a static website host. Keyword search, local semantic search and imports need no provider account. OpenAI embeddings remain an optional, separately billed alternative.

### Run Loop, HAPI and MemSearch entirely on this laptop

The local native stack runs Loop, the private HAPI Hub, its persistent runner and MemSearch in Docker Compose. The runner starts one authenticated Codex `app-server` for the worker lifetime; concurrent Loop Codex agents attach their own native threads to that process. Their Codex login, native thread store, project files, Loop database and memory index stay in local Docker volumes. This is a local CLI app-server managed by Loop, not the visible Codex desktop app process. No AWS account, cloud resources or laptop pairing is used.

```sh
node scripts/setup.mjs
node deployment/local/setup-native.mjs
docker compose -p loop-local-native -f compose.yaml -f deployment/local/compose.yaml up --build -d
```

Open http://localhost:3000, then connect the **This laptop** environment under **Settings → Provider connections** and choose ChatGPT (Codex) or Claude Code. Sign in through the provider's official flow and keep **Subscription** selected for Codex. Compose builds the pinned HAPI/native image and the local MemSearch image on first start. The native HAPI image currently runs as Linux x86-64; Apple Silicon uses Docker's x86 emulation. Local state and generated mutual-TLS credentials live in the ignored `.local-native/` directory and named Docker volumes. The separate Compose project name keeps these volumes apart from another local Loop stack. Back up those before removing volumes. Stop with the same `docker compose -p loop-local-native -f compose.yaml -f deployment/local/compose.yaml down` command; do not add `-v` if you want to keep local sessions and content.

## Checks

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run smoke:browser
npm run smoke:journey
```

`smoke:journey` uses explicit test entrypoints and official SDK fixtures, never live model or Datadog responses. Production has no HTTP switch enabling test adapters. Both browser scripts create isolated temporary databases. Set `CHROMIUM_PATH` if using an existing Chromium executable.

## Deployment and operation

The [deployment guide](docs/loop-v0/DEPLOYMENT.md) covers Docker Compose with Caddy HTTPS, persistent storage, secrets, health checks, backups and installation. One persistent Node host is required; stateless/static hosting is insufficient. The production container smoke job builds all images and checks real unsigned runtime status; its result is recorded in the PR. The laptop-local native stack has been built and its Loop API, HAPI Hub, runner and shared Codex app-server startup verified; provider sign-in and an actual native agent run still require the user’s provider account.

After a working HTTPS deployment exists, open it in Safari → Share → Add to Home Screen → Open as Web App → Add. Loop also includes copy/paste and Shortcut receiving instructions; opening a shared link only creates a draft. Actual iPhone testing remains outstanding.

- [Architecture](docs/loop-v0/ARCHITECTURE.md)
- [Provider capabilities and sign-in limits](docs/loop-v0/CAPABILITIES.md)
- [Workflow DSL, limits and OpenProse decision](docs/loop-v0/WORKFLOWS.md)
- [Workspace MCPs, native results and Apps sandbox](docs/loop-v0/MCP.md)
- [Acceptance status and detailed evidence](docs/loop-v0/EVIDENCE.md)

### Test suites

Run `npm test` for server/domain and shared client logic (Vitest, `tests/`). Add queue, authorization-profile, API and persistence regressions there. Run `npm run test:native` for native adapter subprocess contracts and the companion host integration journey (Node test runner, `test/`). Use `test/helpers.ts` for bounded asynchronous waits. New native protocol/transport fixtures belong in `test/`; both suites run with `npm run test:all`.
