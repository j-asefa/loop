# Loop

A phone-first, private agent workspace. Choose a connected account and model, give an agent a durable @name, and keep its conversations, work and sources in one searchable place.

Implemented: subscription connections through official Codex/Claude Code runtimes; optional OpenAI Responses and Anthropic Messages streaming adapters; importable ChatGPT/Claude history; durable ordered runs and approvals; Feed/Running/Search/Saved; project folders and reversible filing; bounded versioned multi-agent workflows; remote MCP connections and per-agent grants; native chart snapshots and isolated MCP Apps; reviewed link sharing and an installable PWA shell.

**Release status: draft.** Local tests and labeled fixture journeys pass. Live provider/semantic/Datadog verification and an HTTPS deployment with actual iPhone installation remain blocked by external access. Subscription runtimes and sign-in flows are implemented; authenticated allowance usage still needs user sign-in verification. No public preview URL is claimed. See the [acceptance evidence](docs/loop-v0/EVIDENCE.md).

## Run with your subscriptions

Docker with Compose and Node.js 24 (for generating configuration):

```sh
node scripts/setup.mjs
docker compose up --build -d
```

No domain is required. Open http://localhost:3000, create your Loop account, then go to **Settings → Provider connections → Use my subscription**. Choose ChatGPT (Codex) or Claude (Claude Code) and complete the official sign-in flow. Then create an agent with that account and model. No provider API key is required. Plan limits and any extra-usage settings apply; Loop never falls back from a subscription connection to API billing.

Without host Node, generate the configuration using `docker run --rm -v "$PWD:/setup" -w /setup node:24-bookworm-slim node scripts/setup.mjs` first. Setup preserves existing secrets and adds the private runtime token when missing.

The API and independent worker share persistent `loop-data`. Subscription credentials live in separate per-connection runtime volumes. Preserve `.env`, the database volume and runtime credential volumes across restarts. The runtime broker is private and alone has Docker control access. See [subscription setup and boundaries](docs/loop-v0/SUBSCRIPTIONS.md).

For API-only development without Docker: `npm ci`, `npm run setup`, `npm run build`, then `node --env-file=.env scripts/serve.mjs`. Subscription sign-in additionally needs the supplied broker/runtime infrastructure; it cannot run on a static website host. Keyword search and imports need no provider account; embedding search is an optional, separately billed API feature.

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

The [deployment guide](docs/loop-v0/DEPLOYMENT.md) covers Docker Compose with Caddy HTTPS, persistent storage, secrets, health checks, backups and installation. One persistent Node host is required; stateless/static hosting is insufficient. The production container smoke job builds all images and checks real unsigned runtime status; its result is recorded in the PR. Local Docker remains unavailable.

After a working HTTPS deployment exists, open it in Safari → Share → Add to Home Screen → Open as Web App → Add. Loop also includes copy/paste and Shortcut receiving instructions; opening a shared link only creates a draft. Actual iPhone testing remains outstanding.

- [Architecture](docs/loop-v0/ARCHITECTURE.md)
- [Provider capabilities and sign-in limits](docs/loop-v0/CAPABILITIES.md)
- [Workflow DSL, limits and OpenProse decision](docs/loop-v0/WORKFLOWS.md)
- [MCP grants, native results and Apps sandbox](docs/loop-v0/MCP.md)
- [Acceptance status and detailed evidence](docs/loop-v0/EVIDENCE.md)
