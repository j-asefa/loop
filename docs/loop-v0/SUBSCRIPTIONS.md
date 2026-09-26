# Subscription connections

Choose a provider first; its setup defaults to **Subscription**. ChatGPT connects through the official Codex app server (0.157.0); Claude connects through the unmodified Claude Code binary (2.1.280). Both are installed from their official npm packages in the runtime image. API-key connections remain an explicit, separately billed option within each provider's setup. A subscription connection never falls back to either API adapter.

## Connect

1. Run `node scripts/setup.mjs`, then `docker compose up --build -d`. Open http://localhost:3000. Personal mode opens the existing workspace directly; multi-user mode requires a Loop account.
2. Open Settings → Provider connections. If you already have connections, select **Add a provider**. Choose ChatGPT or Claude, keep **Subscription** selected, and choose the machine under **Run on**. Account names are optional. Select **Continue with ChatGPT** or **Continue with Claude**.
3. ChatGPT: open the official verification page and enter the displayed device code. Your account may need device-code sign-in enabled. Claude: open its authorization page and paste the one-time code into the form when requested. The code is forwarded to `claude auth login --claudeai`; Loop does not exchange provider tokens itself.
4. Wait for **ChatGPT connected** or **Claude connected**. A login URL alone never marks a connection connected. Sign-in expires after ten minutes. Closing the sheet leaves the native flow running; reopen Provider connections and select **Continue sign-in** on that account to resume. **Cancel sign-in** terminates the operation. Failed or interrupted sign-ins can be retried on the same account.
5. Create an agent with that connection and a model. Codex models come from the signed-in runtime catalog. Claude exposes official `sonnet`, `opus` and `haiku` CLI aliases; these are not a discovered entitlement list, and the provider enforces your plan's model access when you run.

Provider plan restrictions, subscription limits and any provider-controlled extra-usage settings still apply. Review those settings if you want a hard spending ceiling. Loop never supplies an API key to these runtimes. If a run stops or loses its connection, inspect the saved run before explicitly retrying. Loop does not retry through paid API calls.

**Past ChatGPT/Claude website chats are not automatically available.** Use the existing import flow. Keyword search and local semantic search work without provider API usage. The optional OpenAI embedding backend requires a separately chosen API connection and explicit opt-in; a subscription connection cannot be used for that API.

## Process and credential boundaries

`loop` contains the API and durable worker. A private `runtime-broker` service launches short-lived containers for fixed operations: login, status, logout and one model turn. The broker alone has the Docker socket and requires `LOOP_RUNTIME_TOKEN`; it has no published port. This is a privileged deployment control plane and belongs on a dedicated, trusted Docker host. Neither the web app nor model containers receive the socket.

For the isolated broker, each connection has its own Docker credential volume, named from the deployment token and a SHA-256 digest of owner ID + connection ID. Native credentials are kept by the official runtime in that volume, not returned to the browser or stored in Loop's connection secret column. Treat these volumes as sensitive credentials; protect the host disk/backups. They are native credential files, not encrypted by Loop's API-key encryption layer. Preserve the runtime token across upgrades: rotating it changes the deployment namespace and requires reconnecting accounts and explicitly retiring the old volumes.

Operation containers run as UID 1000, with a read-only root filesystem, dropped capabilities, no-new-privileges, process/memory/CPU limits, a temporary /tmp directory, their own writable persistent home volume and no application database/secrets or host mounts. Only the provider runtime sees its own credential files. Runtime subprocess environments are constructed from an allowlist: no ambient API keys, cloud-provider credentials, alternate base URLs or OAuth tokens are inherited. Every turn verifies native subscription authentication first. Each agent starts in a stable directory under `/home/node/workspaces/` in its connection volume. The directory is keyed by owner and agent, so checkouts, edits, dependencies and test results survive model rounds, new conversations and container restarts. The read-only image root does not make this working directory read-only. Changing provider connections selects a different volume; agents sharing an account are not filesystem security boundaries.

The broker serializes operations per account and caps concurrently executing containers. The worker's cancellation/disconnection aborts the broker request, which removes the operation container. Native login persists across API/worker/broker restarts; a login operation in progress must be restarted after broker restart. Orphan operation containers for the same deployment are removed on broker startup. Disconnect immediately disables Loop submissions and invokes native logout. If the broker is unreachable, Loop reports the failure; retry disconnect to complete native logout. Credential volumes are retained for reconnect and must be managed separately from `docker compose down -v`.

## Tools, history and output

Loop continues to own durable messages, context snapshots, workflow checkpoints, artifacts and approvals. Each runtime turn receives that bounded history and a structured output schema: either an answer or one named Loop tool request. Both managed and native-host runtimes enable their native tools: Codex starts threads with `sandbox: danger-full-access` and `approvalPolicy: never`; Claude uses `bypassPermissions` without an empty tool list or forced empty MCP configuration. The container boundary remains in place. Agents can use shell commands, edit files, run tests, discover skills and use configured native integrations. The runtime image includes Git, gh, Node/npm, Python, curl, ripgrep and a C/C++ build toolchain.

Loop validates the named tool against the workspace’s connected MCP catalog, validates arguments against the discovered schema, and follows the same workspace approval preference as API agents. Native tools execute in the runtime; Loop tools execute through the Loop tool gateway. Results re-enter the next runtime turn and retain native artifact/MCP Apps rendering. All uncertain external outcomes remain non-replayable automatically.

Subscription responses are buffered until the runtime completes and the structured result validates; they currently appear as a completed message rather than token-by-token text. Run status/approval events remain live and work continues when the phone closes. Each runtime turn uses a fresh ephemeral/native non-persistent session; Loop supplies the selected conversation history, so unrelated native sessions cannot bleed into it. Context replay consumes subscription allowance. Wall-clock limits and byte limits apply; the requested output-token budget is an instruction, not an exact cross-runtime token cap. Loop does not impose a model/tool round cap.

### Private GitHub repositories

With **Allow connected tools** enabled and one connected official GitHub MCP account, managed runtimes also receive that account's bearer token for native Git and gh commands. This enables authenticated clones, branches, pushes and PR reviews within the token's existing permissions. The token travels separately from model context, exists only in the child process environment, and is supplied to Git by an HTTPS `github.com` credential helper. Loop does not put it in argv, repository URLs or credential files, and redacts it from returned answers and traces. Revoking the integration or restoring **Ask every time** stops supplying it to subsequent turns. Already running commands finish with the credentials they started with. Multiple distinct connected GitHub accounts are not selected arbitrarily. Native laptop hosts continue using their own existing credentials.

## Verification

The test suite drives the actual entrypoint with explicit protocol fixtures for both CLIs: native sign-in events, auth/account checks, model selection, answer/tool results, refusal of API-authenticated credentials, quota failure, environment scrubbing and container isolation arguments. Browser fixtures exercise both connection UIs, worker completion, subscription → MCP approval → result, logout and cross-user denial. These fixtures are not live subscription usage.

The pinned real binaries were installed and their unsigned status paths exercised locally. CI builds all production images, starts the default Compose stack without a domain, checks maintained-auth signup/session + worker health, and asks both real unsigned runtimes for status through the private broker. The current CI result and tested commit are recorded in the PR. Actual authenticated model calls and provider-reported subscription usage remain a user sign-in check, not a claimed pass.

Official references checked 2026-09-23:

- https://learn.chatgpt.com/docs/app-server — device-code login, account/rate limits, model catalog and structured turns.
- https://code.claude.com/docs/en/cli-reference — auth login/status/logout, print JSON, structured output, tool controls.
- https://code.claude.com/docs/en/legal-and-compliance — hosting the unmodified binary with end-user authentication, distinct from implementing claude.ai login in a custom API client. Operators must comply with those hosting conditions and applicable terms.

## Native remote hosts

The isolated-container boundaries above do not apply to paired native hosts. Direct Codex app-server and `runtime/host.mjs` retain the machine's native tools, working directory, skills and MCP configuration. Codex requests full access; Claude uses bypass-permissions mode without a Loop turn cap. Administrator policies and provider restrictions still apply. Pairing reuses the host user's login, and unpairing does not sign it out. Loop's workspace tools continue through the normal workspace approval path. See [native host setup](../feedback/RUNTIMES.md#native-host-for-claude-code-and-codex).
