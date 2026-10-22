# Remote server runtimes

These connections belong to the [server profile](server.md). They are separate from [local companion pairing](pairing.md). Keep runtime listeners private and connect from the Loop API/worker network, not just the browser.

## Isolated remote runtime

On the remote Docker host, check out Loop, generate configuration, and start only the runtimes:

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

In **Settings → Provider connections**, select **Add a provider** if you already have a connection, then choose Claude or ChatGPT. Keep **Subscription** selected, choose the remote machine under **Run on**, and continue to the official provider sign-in. Agents using that connection execute their provider runtime on that machine. Managed execution uses isolated containers with native tools and a persistent writable workspace for each agent. Agents can clone repositories, edit code and run tests; their files survive messages and restarts. This does not mount arbitrary host folders or inherit host credentials. Loop's queue, approvals, history and feed stay on the Loop server.

For Claude, choose **Open Claude sign-in**, finish the browser steps, then paste the one-time code into Loop and choose **Complete sign-in**. Claude Code currently opens `claude.com/cai/oauth/authorize`; older `claude.ai` links remain supported. The runtime allows 45 seconds to produce a link and ten minutes to complete the browser steps, then stops the attempt and offers retry. If a runtime was updated, rebuild both the runtime and broker images on that machine. Container smoke checks exercise the actual pinned Claude CLI through link generation and cancellation; completing sign-in still requires your account. See [Claude's official authentication instructions](https://code.claude.com/docs/en/authentication).

Removing a machine requires disconnecting its provider and MCP connections first. Tokens are encrypted at rest and omitted from listing responses. Public endpoints use DNS/address validation; private origins require the explicit administrator allowlist above.

## Connect directly to Codex app-server

Loop can connect to the official app-server running on an existing Codex machine. Docker and a Loop broker are not required on that machine. This uses the host's ChatGPT sign-in; Loop stores only the encrypted connection token. It does not attach to a desktop window or adopt another client's active threads.

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

## Native host for Claude Code and Codex

Claude Code provides a [headless CLI with structured streaming](https://code.claude.com/docs/en/headless), rather than Codex's app-server protocol. Loop includes a small native host service that runs that official CLI directly on your laptop. It also supports local Codex app-server over stdio. Node 24 or newer and the corresponding official CLI must be installed; Docker and npm dependencies are not needed by this host service.

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

Claude runs with `bypassPermissions`, its native tool set and configured MCPs, and no Loop-imposed turn cap. Codex requests full native access. Subscription agents have no default wall-clock deadline or fixed round cap: long-running coding work continues until the runtime finishes, the user cancels, or an explicit workflow execution budget expires. Runtime HTTP streams send keepalives during quiet work and retain connection/idle timeouts without imposing a total-duration or cumulative-response-size cap. API-provider request timeouts and provider limits still apply. Native tools do not pass through Loop's per-call approval screen; host administrator rules and provider limits still apply. Tools requiring interactive sign-in or additional user input must complete that setup on the host. Loop does not supply invented answers to native input prompts.

The Feed's Done filter keeps completed answers as separate cards; see [Feed behavior](workspace.md#feed-and-reading-position). Result cards also appear on the agent's profile. Open an agent's profile and select **Traces** for public intermediate updates, commands and tool activity. The Feed's **Working** filter shows the current formatted preview. Update the remote native host checkout and restart its runner to capture these native activity events.

Pairing never starts a host login or logs the shared account out. If sign-in expires, sign in using the official CLI on the laptop and check the connection again. Unpairing cancels only that Loop connection's work. Cancellation terminates its native process tree. Subscription runs do not inherit API-billing keys or alternate provider backends from the launch environment, and never fall back to API billing. The isolated Docker broker remains a separate connection type.
