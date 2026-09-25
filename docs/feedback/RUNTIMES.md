# Remote agents and MCP installation

## Isolated remote runtime

On the remote Docker host, check out this branch, generate configuration, and start only the runtimes:

```sh
node scripts/setup.mjs
docker compose -f compose.remote.yaml up --build -d
```

The broker binds to the remote host's loopback interface. Its `LOOP_RUNTIME_TOKEN` is the access token used when pairing Loop. Provider credentials remain in separate per-connection Docker volumes on this machine.

For a direct Node deployment of Loop, open a tunnel on the machine running Loop's API and worker:

```sh
ssh -N -L 3310:127.0.0.1:3100 user@remote-machine
```

Add `LOOP_ALLOWED_RUNTIME_ORIGINS=http://127.0.0.1:3310` to Loop's environment and restart both API and worker. In **Settings → Runtime machines**, add that URL and the remote broker token. Alternatively, expose the broker through a private HTTPS reverse proxy and use its HTTPS address. Container deployments must use an address reachable from the Loop container; a tunnel on the browser's machine alone does not provide that path.

In **Settings → Provider connections**, select **Add a provider** if you already have a connection, then choose Claude or ChatGPT. Keep **Subscription** selected, choose the remote machine under **Run on**, and continue to the official provider sign-in. Agents using that connection execute their provider runtime on that machine. Remote execution uses isolated containers; it does not mount arbitrary host folders or inherit host credentials. Loop's queue, approvals, history and feed stay on the Loop server.

For Claude, choose **Open Claude sign-in**, finish the browser steps, then paste the one-time code into Loop and choose **Complete sign-in**. Claude Code currently opens `claude.com/cai/oauth/authorize`; older `claude.ai` links remain supported. The runtime allows 45 seconds to produce a link and ten minutes to complete the browser steps, then stops the attempt and offers retry. If a runtime was updated, rebuild both the runtime and broker images on that machine. Container smoke checks exercise the actual pinned Claude CLI through link generation and cancellation; completing sign-in still requires your account. See [Claude's official authentication instructions](https://code.claude.com/docs/en/authentication).

Removing a machine requires disconnecting its provider and MCP connections first. Tokens are encrypted at rest and omitted from listing responses. Public endpoints use DNS/address validation; private origins require the explicit administrator allowlist above.

## Connect directly to Codex app-server

Loop can now connect to the official app-server running on an existing Codex machine. Docker and a Loop broker are not required on that machine. This uses the host's ChatGPT sign-in; Loop stores only the encrypted connection token. It does not attach to a desktop window or adopt another client's active threads.

On the remote machine, sign in and start a listener with a new private access-token file:

```sh
# Start in the project directory you want the agent to use.
codex login
umask 077
openssl rand -hex 32 > "$HOME/.codex/loop-app-server-token"
codex app-server --listen ws://127.0.0.1:4500 \
  --ws-auth capability-token \
  --ws-token-file "$HOME/.codex/loop-app-server-token"
```

Keep the listener running. For a direct Node deployment of Loop, open this tunnel on the machine running Loop's API and worker:

```sh
ssh -N -L 3311:127.0.0.1:4500 user@remote-machine
```

Add `ws://127.0.0.1:3311` to the comma-separated `LOOP_ALLOWED_RUNTIME_ORIGINS` in Loop's environment and restart the API and worker. In a container deployment, use an address reachable from the container, or run the tunnel within its network; the browser's localhost is not the Loop server. For a private HTTPS proxy, use its `wss://` address and forward the WebSocket upgrade and Authorization header. Never expose an unauthenticated listener.

1. Open **Settings → Runtime machines** and choose **Codex app-server** as the connection type.
2. Enter a machine name, the reachable `ws://` or `wss://` address, and the contents of the token file as **Runtime access token**. Choose **Test & add machine**. Loop checks the app-server handshake, ChatGPT sign-in and model catalog before saving it.
3. Open **Provider connections → Add a provider → ChatGPT**, keep **Subscription** selected, choose that machine under **Run on**, and select **Connect remote Codex**.
4. Create an agent using that account and one of its discovered models.

The app-server remains signed in when the Loop connection is removed. If its login expires, run `codex login` on the remote machine and use **Check connection** in Loop. API-key-only app-servers are rejected for this subscription connection; there is no fallback to API billing.

This integration runs Loop turns in separate ephemeral Codex threads and supplies Loop's conversation history on each turn. Cancellation interrupts only that turn, then unsubscribes. The host's existing conversations remain separate. Native shell, file edits, network, skills, plugins and configured MCPs remain enabled. Loop requests `danger-full-access` with approval policy `never`, without overriding the host's tool configuration; administrator requirements may still reject or constrain that mode. Native actions execute directly on the machine as its user. Pair only a Loop workspace that you trust with that access.

Workspace MCP tools remain available through Loop's approvals. Installing a workspace command MCP requires a Loop broker; native-host MCPs are managed in Codex or Claude on the machine. Agent-requested workspace installs fall back to Loop's default broker when the agent runs on a native host.

OpenAI labels WebSocket transport experimental. See the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). A real unsigned Codex CLI 0.148.0 listener accepted a full-access ephemeral thread and a harmless native command/file write in a temporary project, while keeping saved MCP configuration unchanged. Authenticated inference and native approval round trips use deterministic fixtures; no real remote account was connected for testing.

## Native host for Claude Code and Codex

Claude Code provides a [headless CLI with structured streaming](https://code.claude.com/docs/en/headless), rather than Codex's app-server protocol. Loop now includes a small native host service that runs that official CLI directly on your laptop. It also supports local Codex app-server over stdio. Node 24 or newer and the corresponding official CLI must be installed; Docker and npm dependencies are not needed by this host service.

On the remote laptop, sign in as the user whose files and tools the agents should use. From your Loop checkout, create a private service token and start the runner:

```sh
claude auth login
# For Codex agents, also run: codex login
umask 077
mkdir -p "$HOME/.config/loop"
openssl rand -hex 32 > "$HOME/.config/loop/host-token"
LOOP_RUNTIME_TOKEN_FILE="$HOME/.config/loop/host-token" \
  LOOP_RUNTIME_WORKDIR="/absolute/path/to/your/project" \
  node runtime/host.mjs
```

The runner listens on `127.0.0.1:3101`. Keep it running, or supervise it as that user. It retains the user's HOME, runtime configuration, PATH, project instructions, skills and MCP configuration. The chosen working directory is a real host directory; Loop's Project selection controls where results are filed in Loop. You can run a separate runner/port per host project. `PORT` changes the listener port; `LOOP_RUNTIME_BIND` explicitly changes its bind address.

For a direct Node deployment, open the tunnel from Loop's server:

```sh
ssh -N -L 3312:127.0.0.1:3101 user@remote-machine
```

Add `http://127.0.0.1:3312` to `LOOP_ALLOWED_RUNTIME_ORIGINS` and restart the API and worker. For Docker deployments, the tunnel or private HTTPS endpoint must be reachable from the Loop containers, as described above.

1. Open **Settings → Runtime machines → Native host · Codex & Claude Code**.
2. Enter the reachable runtime address and the contents of `host-token`, then **Test & add machine**.
3. Open **Provider connections → Add a provider → Claude** (or ChatGPT), select **Subscription** and choose this machine under **Run on**.
4. Choose **Connect remote Claude** (or Codex). Loop checks the account already signed in on that machine. Create an agent using the connection.

Claude runs with `bypassPermissions`, its native tool set and configured MCPs, and no Loop-imposed turn cap. Codex requests full native access. Loop's model/tool orchestration also has no fixed round cap; cancellation, execution timeouts and provider limits still apply. Native tools do not pass through Loop's per-call approval screen; host administrator rules and provider limits still apply. Tools requiring interactive sign-in or additional user input must complete that setup on the host. Loop does not supply invented answers to native input prompts.

Only completed answers appear in Feed. Open an agent's profile and select **Traces** for public intermediate updates, commands and tool activity. Running shows the current formatted preview. Update the remote native host checkout and restart its runner to capture these native activity events.

Pairing never starts a host login or logs the shared account out. If sign-in expires, sign in using the official CLI on the laptop and check the connection again. Unpairing cancels only that Loop connection's work. Cancellation terminates its native process tree. Subscription runs do not inherit API-billing keys or alternate provider backends from the launch environment, and never fall back to API billing. The isolated Docker broker remains a separate connection type.

## Claude's corresponding options

- The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) embeds Claude Code's agent loop in Python or TypeScript, including sessions, tools and permissions. A service we operate on the remote machine can expose that to Loop. The [headless CLI](https://code.claude.com/docs/en/headless) also provides structured streaming. Loop uses the official CLI through either the isolated broker or the native host service described above. Anthropic's SDK documentation says third-party products must use API authentication unless Anthropic has approved subscription login/rate-limit access.
- [Remote Control](https://code.claude.com/docs/en/remote-control) runs work on the user's machine and connects it to Claude's own web/mobile clients. Its documented interface does not provide a Loop client API.
- [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) is a separate API service with hosted or self-hosted execution. It is a beta option for a future integration and requires Claude API access.

Sources checked 2026-09-23. The Agent SDK and headless CLI are the corresponding embedding options; they do not speak the Codex app-server protocol.

## MCP catalog

Open **Settings → Tools & integrations → Browse catalog**. Search or filter 50 curated integrations and choose **Install**. Connected tools are available to every agent in the workspace. The Installed view manages testing, disabling, disconnecting and credentials; Custom server retains URL and JSON configuration.

- Public tools connect immediately. The catalog includes Playwright, Sequential Thinking, Context7, DeepWiki, Exa, Hugging Face and Cloudflare Docs without account setup.
- OAuth tools open the provider's sign-in page. API-key integrations ask only for the necessary fields. Keys are encrypted and are never returned to the browser. Provider subscriptions, permissions and usage limits still apply.
- Slack and Asana require a registered OAuth app. Their entries link to the publisher's instructions, collect the app credentials, and display Loop's exact callback URL. Set up that app once, then complete provider sign-in.
- Command tools use the supplied isolated MCP runtime, with an optional paired machine selector. Hosted tools connect directly to the publisher. Catalog package versions are pinned.
- A connection is marked Installed only after discovery succeeds. Failed connections remain retryable. Concurrent/repeated installs reuse one connection per catalog entry in the workspace, and matching custom hosted connections are reused.

The checked-in [catalog definitions](../../src/server/mcp/catalog-data.ts) include a publisher setup link for every entry. Endpoints and packages were reviewed against publisher documentation and the [official MCP Registry](https://registry.modelcontextprotocol.io/) on 2026-09-23. This is a curated list, not a live import of executable registry content. Update and verify the checked-in definition to add an entry or change a pinned package version.

For an opt-in live discovery check of the five public hosted servers (no account credentials or tool calls):

```sh
node --import tsx scripts/smoke-mcp-catalog.mjs
```

Authenticated provider sign-ins need the user's real accounts and are not all covered by live testing. Automated tests cover the setup forms, OAuth handoff, encrypted storage, deduplication, retry, owner isolation, and workspace availability.

## MCP configuration

Open **Settings → Tools & integrations → Custom server → Paste MCP JSON configuration**. The supplied configuration works directly:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Select Loop's server or a paired remote machine. The MCP image includes headless Chromium, so this configuration can discover tools and browse without a separate browser installation. Command arguments are passed as an argument array. The API/worker does not execute the supplied command on its host.

Each stdio process runs as an unprivileged user with a read-only container filesystem, resource limits and temporary writable directories. No Docker socket or host credentials are mounted. The container provides the isolation boundary; bundled Chromium runs without its additional sandbox. Package versions can be pinned in `args`.

Also supported:

```json
{
  "mcpServers": {
    "service": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_SERVICE_TOKEN" }
    }
  }
}
```

Credentials and command environment variables are encrypted. Discovery reports failures individually, and saved configurations can be tested again. Connected tools are immediately available to every current and future agent in the workspace. An agent can request installation itself; Loop first shows a workspace-wide installation approval. In Settings → Tools & integrations, choose **Allow connected tools** to run MCP calls automatically for all your agents and resume waiting calls. **Ask every time** restores prompting for new calls. The preference persists for your workspace, and calls remain recorded in conversation history. Disable or disconnect a server once to stop new calls from every agent. Agent-requested command servers use that agent connection's runtime machine.

Stateful stdio processes are isolated per run and retained across tool calls and approval pauses. They close when the run finishes, is cancelled, or reaches the broker's 20-minute session limit. Worker restarts interrupt affected work; browser state is not durable across process restarts.

For a real transport/browser check after building the MCP image:

```sh
LOOP_MCP_IMAGE=loop-mcp:0.1 node --import tsx scripts/smoke-mcp-runtime.mjs
```

## Local semantic search

Open **Search → Enable or configure semantic search**, enable it, and choose **Local model**. The worker downloads and caches `Xenova/all-MiniLM-L6-v2` under the persistent Loop data directory, then indexes messages and artifacts in batches. Text is embedded locally. An unavailable model or network keeps keyword search usable. Initial indexing is asynchronous; the search view reports pending items.

Keep the data directory across deployments to retain the model cache. The optional OpenAI embedding account sends content to that API and retains its existing billing disclosure. Disabling semantic search deletes stored vectors.

## Commands and skills in messages

Open **Commands & skills** in the main composer or a conversation reply. Typing `/` or `$` into an empty message opens the same searchable picker. Choose an item, add the task or arguments, then send. Refresh queries the selected agent's machine again; switching agents clears the previous machine's list.

- **Codex app-server / native Codex host:** enabled skills come from `skills/list`. `$skill-name` is resolved again at execution and sent as a native `skill` input with its discovered path. `/review` runs `review/start` against uncommitted changes; `/review <instructions>` starts a custom review. Other Codex terminal UI commands are not treated as chat prompts.
- **Native Claude Code host:** the official CLI's SDK initialization returns available commands, including user, project and plugin skills and custom commands. Discovery sends no user prompt or model request. A selected slash command is sent directly to Claude; Loop instructions and earlier messages stay in the appended context, sent through streamed initialization so long histories do not exceed process argument limits. Commands that require persistent terminal history are shown as unavailable when advertised, because Loop currently uses separate headless sessions.
- **API connections and isolated brokers:** the picker explains that host commands require a native runtime. Rebuild/restart `runtime/host.mjs` from this branch on a paired laptop to enable discovery there. An unreachable, busy or older runtime shows a refreshable error rather than a made-up catalog.

The Loop run retains its original command text. Native tools remain governed by the host configuration. Workspace MCP calls keep Loop's existing approval flow. Subscription runs use the runtime's 30-minute deadline unless a workflow supplies a shorter budget.

Protocol references: [Codex app-server skills and reviews](https://learn.chatgpt.com/docs/app-server), [Claude commands and skills](https://code.claude.com/docs/en/agent-sdk/slash-commands). `scripts/native-harness-smoke.mjs` verifies discovery with both pinned real binaries using temporary unsigned-in homes, no network and no model turns.

## Stopped and missing responses

Feed cards and conversation messages show the saved run state, including failure details, interruption, cancellation, pause and pending approval. The feed links to runs needing attention even when nothing is executing. A provider that ends without text or a tool call is recorded as failed instead of a successful empty response.

Open a failed conversation and choose **Retry as a new run** after reviewing partial work. Old runs remain in history and are not automatically replayed. MCP schema validation supports draft 2020-12, 2019-09 and draft-07, including the browser MCP's advertised schema; argument validation and approvals remain enforced.
