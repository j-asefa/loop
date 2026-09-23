# Subscription connections

Loop defaults to **Use my subscription**. ChatGPT connects through the official Codex app server (0.156.1); Claude connects through the unmodified Claude Code binary (2.1.280). Both are installed from their official npm packages in the runtime image. API-key connections remain an explicit, separately billed option. A subscription connection never falls back to either API adapter.

## Connect

1. Run `node scripts/setup.mjs`, then `docker compose up --build -d`. Open http://localhost:3000 and create your Loop account.
2. Settings → Provider connections → Use my subscription. Choose ChatGPT or Claude, name the account, and continue.
3. ChatGPT: open the official verification page and enter the displayed device code. Your account may need device-code sign-in enabled. Claude: open its authorization page and paste the one-time code into the form when requested. The code is forwarded to `claude auth login --claudeai`; Loop does not exchange provider tokens itself.
4. Wait for **connected · Subscription allowance**. A login URL alone never marks a connection connected. Sign-in expires after ten minutes. Closing the sheet does not cancel the native flow; reopening resumes polling. Cancel sign-in terminates the operation.
5. Create an agent with that connection and a model. Codex models come from the signed-in runtime catalog. Claude exposes official `sonnet`, `opus` and `haiku` CLI aliases; these are not a discovered entitlement list, and the provider enforces your plan's model access when you run.

Provider plan restrictions, subscription limits and any provider-controlled extra-usage settings still apply. Review those settings if you want a hard spending ceiling. Loop never supplies an API key to these runtimes. If a run stops or loses its connection, inspect the saved run before explicitly retrying. Loop does not retry through paid API calls.

**Past ChatGPT/Claude website chats are not automatically available.** Use the existing import flow. Keyword search works without API usage. Optional embedding search still requires a separately chosen OpenAI API connection and explicit opt-in; a subscription connection cannot be used for that API.

## Process and credential boundaries

`loop` contains the API and durable worker. A private `runtime-broker` service launches short-lived containers for fixed operations: login, status, logout and one model turn. The broker alone has the Docker socket and requires `LOOP_RUNTIME_TOKEN`; it has no published port. This is a privileged deployment control plane and belongs on a dedicated, trusted Docker host. Neither the web app nor model containers receive the socket.

Each connection has its own Docker credential volume, named from the deployment token and a SHA-256 digest of owner ID + connection ID. Native credentials are kept by the official runtime in that volume, not returned to the browser or stored in Loop's connection secret column. Treat these volumes as sensitive credentials; protect the host disk/backups. They are native credential files, not encrypted by Loop's API-key encryption layer. Preserve the runtime token across upgrades: rotating it changes the deployment namespace and requires reconnecting accounts and explicitly retiring the old volumes.

Operation containers run as UID 1000, with a read-only root filesystem, dropped capabilities, no-new-privileges, process/memory/CPU limits, private temporary work directories, their own home volume and no application database/secrets or host mounts. Only the provider runtime sees its own credential files. Runtime subprocess environments are constructed from an allowlist: no ambient API keys, cloud-provider credentials, alternate base URLs or OAuth tokens are inherited. Every turn verifies native subscription authentication first.

The broker serializes operations per account and caps concurrently executing containers. The worker's cancellation/disconnection aborts the broker request, which removes the operation container. Native login persists across API/worker/broker restarts; a login operation in progress must be restarted after broker restart. Orphan operation containers for the same deployment are removed on broker startup. Disconnect immediately disables Loop submissions and invokes native logout. If the broker is unreachable, Loop reports the failure; retry disconnect to complete native logout. Credential volumes are retained for reconnect and must be managed separately from `docker compose down -v`.

## Tools, history and output

Loop continues to own durable messages, context snapshots, workflow checkpoints, artifacts and approvals. Each runtime turn receives that bounded history and a structured output schema: either an answer or one named Loop tool request. Claude turns disable native tools and external MCP configuration. Codex turns disable shell, browser, app and code-execution features, use a read-only sandbox with approval set to never, and reject native tool/permission requests. The unmodified runtime binaries still provide their native authentication methods; this restriction applies to model tools, not authentication.

Loop validates the named tool against current agent grants, validates arguments against the discovered schema, and requires the same explicit approval as API agents. A tool request cannot directly invoke the provider runtime's tools. Approved results re-enter the next runtime turn and retain native artifact/MCP Apps rendering. All uncertain external outcomes remain non-replayable automatically.

Subscription responses are buffered until the runtime completes and the structured result validates; they currently appear as a completed message rather than token-by-token text. Run status/approval events remain live and work continues when the phone closes. Each runtime turn uses a fresh ephemeral/native non-persistent session; Loop supplies the selected conversation history, so unrelated native sessions cannot bleed into it. Context replay consumes subscription allowance. Wall-clock limits and byte limits apply; the requested output-token budget is an instruction, not an exact cross-runtime token cap. Claude additionally has a three-native-turn cap per request for structured-output handling.

## Verification

The test suite drives the actual entrypoint with explicit protocol fixtures for both CLIs: native sign-in events, auth/account checks, model selection, answer/tool results, refusal of API-authenticated credentials, quota failure, environment scrubbing and container isolation arguments. Browser fixtures exercise both connection UIs, worker completion, subscription → MCP approval → result, logout and cross-user denial. These fixtures are not live subscription usage.

The pinned real binaries were installed and their unsigned status paths exercised locally. CI builds all production images, starts the default Compose stack without a domain, checks maintained-auth signup/session + worker health, and asks both real unsigned runtimes for status through the private broker. The current CI result and tested commit are recorded in the PR. Actual authenticated model calls and provider-reported subscription usage remain a user sign-in check, not a claimed pass.

Official references checked 2026-09-23:
- https://learn.chatgpt.com/docs/app-server — device-code login, account/rate limits, model catalog and structured turns.
- https://code.claude.com/docs/en/cli-reference — auth login/status/logout, print JSON, structured output, tool controls.
- https://code.claude.com/docs/en/legal-and-compliance — hosting the unmodified binary with end-user authentication, distinct from implementing claude.ai login in a custom API client. Operators must comply with those hosting conditions and applicable terms.
