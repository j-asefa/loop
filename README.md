<h1><img src="public/icon-192.png" width="32" height="32" alt="Loop logo"> Loop: your coding agents, from your phone</h1>

Loop is a phone feed of the work your coding agents do: a record of results you can read, reply to and save. It works across the harnesses you already have installed (Codex, Claude Code, Pi, OpenCode, Antigravity, Muse Code and Grok Build, plus custom ACP agents) and runs on your own computer, with no account and no server to set up. Pair your phone by scanning a QR code; the agents keep running on your machine while your phone is away.

<table>
  <tr>
    <th>Needs you: approve, answer or continue</th>
    <th>Feed: finished work as results</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/needs-you.png" alt="The top of the Loop Feed: agent shortcuts and a Needs you card asking to approve @orion's pull request review on acme/storefront #42" width="300"></td>
    <td><img src="docs/screenshots/feed.png" alt="The Feed's Done tab: result cards from @orion, a review of pull request #42, and @bug-hunter, the root cause of order totals off by a cent" width="300"></td>
  </tr>
  <tr>
    <th>Result: read and reply</th>
    <th>Saved: results worth keeping, labelled</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/result.png" alt="A result from @bug-hunter using Kimi K3.1 Pro: the order-total fix, linked pull request and Reply action" width="300"></td>
    <td><img src="docs/screenshots/saved.png" alt="Saved under Your profile: a searchable list with labels such as Rounding fix and Review before merge, each result with Reply, Saved, Remind me and File" width="300"></td>
  </tr>
  <tr>
    <th>Agent profile: one agent's work</th>
    <th>Your profile: a history of your prompts</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/agent-profile.png" alt="The @orion agent profile: its tagline, Claude Opus 5.5 model, computer, team and current work awaiting approval, above its results" width="300"></td>
    <td><img src="docs/screenshots/your-profile.png" alt="Your profile: robot avatar, banner, name, handle, bio and counts, above the Messages tab showing a prompt you sent to @orion" width="300"></td>
  </tr>
</table>

Screenshots use illustrative sample data, captured from Loop’s UI. Regenerate them with `node scripts/readme-screenshots.mjs` after building the UI.

## Behind the name

Loop is named for the song I played on loop for my son: “Ol’ ’55,” his favourite, and the only song that would get him to sleep. I built Loop while he slept in my arms.

## Why Loop

- 🗂️ **A record of results, not a chat log.** Finished answers arrive as cards in one Feed (what needs you on top, then **Done**, **Working**, **Queued**, **Threads**, **Replies**); plans, diffs, command output and traces stay one tap away. Run several agents and conversations at once and follow them through the Feed, Projects and Search. Phone notifications arrive when a result is ready, not for every tool call. See [workspace](docs/workspace.md) and [notifications](docs/workspace.md#notifications).
- 🔌 **The harnesses you already have.** `loop` discovers Codex, Claude Code, Pi, OpenCode, Antigravity, Muse Code and Grok Build on your computer and connects their native adapters in one workspace; custom ACP agents can be added too. Each keeps its own context, tools, sign-in and model configuration, including [local models through Pi or OpenCode](#use-local-models). Loop verifies the harness billing policy and never switches billing methods after a failure. See [harnesses](docs/harnesses.md).
- 🏠 **On your own computer: no account, no server.** Agents run on your machine and keep working after your phone disconnects. Scan a QR code, pair in your phone's browser and add Loop to your home screen: no app store and no account signup, on iPhone and Android. `loop start` launches a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) through a pinned, hash-verified `cloudflared`, so your phone reaches your computer from anywhere without port forwarding, a domain, a VPN or a Cloudflare account. Restarts and upgrades keep the address and your paired phone; if it changes (after `loop stop` or a reboot), run `loop pair` and scan again. Only paired devices can sign in, and you can revoke them. Traffic is HTTPS but not end-to-end encrypted: with the default Quick Tunnel, Cloudflare terminates TLS, so use `--public-url` with your own TLS proxy if that matters to you. See [pairing](docs/pairing.md) and [SECURITY.md](SECURITY.md).
- 🔖 **Save what matters.** Save any result or message from its Feed card or inside its thread; saving a reply keeps the result card it produced with it. Saved, under Your profile, is one searchable list, newest first, with optional short labels such as "Chosen approach". Reply to a saved item to quote it back into its thread, so it is the latest thing the agent reads. See [Saved](docs/workspace.md#your-profile-later-and-deferred-work).
- ↩️ **Reply to any message, or just part of it.** Loop quotes the message you picked, or only the lines you highlight, in front of your reply, so that exact update is back in front of the agent even if the harness's own history no longer has it. Mid-run, API, Codex, Claude Code, Pi and Muse Code agents support live replies; OpenCode, Antigravity, Grok Build and ACP queue replies for the next turn.
- ⏱️ **Built for checking in, not sitting in.** Each Feed card offers the one action its thread is waiting for (approve, answer, continue a draft or review a result) and opens at that message. A "while you were away" card sums up what finished, failed or needs you. **Remind me**, **Send later** and **Queue after this task** pick work up when the agent is free, and scheduled sends reuse their idempotency key, so a retry after a crash never sends twice.
- 🤝 **Teams.** A manager agent delegates to worker agents. Presets cover **Review code changes**, **Ask an LLM council**, **Build a feature** and **Investigate a bug**, and you can build a custom team from existing agents. Review and merge your GitHub pull requests in the Pull requests tab. See [teams](docs/workspace.md#teams).
- 📶 **Built for flaky phone connections.** Loop records each send before dispatching it, never automatically replays an uncertain one, and catches up on missed updates after a reconnect. See [architecture](docs/architecture.md).
- 🧪 **Several computers, one workspace (experimental).** Fleets connect companion machines and are off unless you start Loop with `--fleet`. See [fleets](docs/pairing.md#fleets-experimental).

## Setup

Use Node.js **24** and a persistent disk. Building from source on Linux also requires **Python 3.8+** for [command supervision](docs/development.md#command-supervision). Docker is required only for container execution.

```sh
git clone https://github.com/j-asefa/loop.git loop
cd loop
bash install
loop start
```

The installer runs `npm ci`, builds Loop and links `loop` into a writable directory on your PATH. If none is writable, it uses `~/.local/bin` and prints the PATH command needed for your shell. Keep the checkout in place while using this installation.

`loop start` prints a single-use pairing code. Scan it with your phone's camera:

<img src="docs/screenshots/loop-start.png" alt="Illustrative fixture terminal output of loop start --direct: workspace ready, pairing instructions, a QR code and the trycloudflare.com pairing link" width="640">

The terminal screenshot uses an isolated fixture tunnel; its pairing link is no longer active.

## Install on your phone

1. In the Loop checkout on your computer, run `loop start`. It starts the workspace and displays a pairing QR code.
2. Scan the QR code with your phone's camera. The link opens Loop's pairing page in your default mobile browser. Tap **Pair and open Loop**.
3. In the browser, open **Share** and choose **Add to Home Screen**. On Android browsers, this may appear as **Install app** or **Add to Home screen** in the browser menu.
4. Open Loop from the new home screen icon.

The computer must stay awake for phone access. Pairing links are single use and expire after two minutes; run `loop pair` for a fresh code. `loop restart` and `loop upgrade` keep the Quick Tunnel address; after `loop stop` or a reboot it can change, so scan a new code and add the new page to your home screen. See [pairing and recovery](docs/pairing.md).

## Run the server

```sh
npm run setup
loop server
```

Open **http://localhost:3000**. The server starts its worker and opens a personal workspace by default. Add a provider connection in Settings, then create an agent. API connections require your own provider credentials; subscription connections require a configured runtime.

For the supplied Docker subscription stack:

```sh
npm run setup
docker compose up --build -d
```

See [server operation](docs/server.md) for accounts, remote access, runtime machines, backups and subscription runtimes.

## Use a coding harness

Install Codex, Claude Code, Pi, OpenCode, Antigravity, Muse Code or Grok Build on your computer, configure its model provider (or sign in for a cloud account), then run `loop` in your project directory. Loop discovers supported installed harnesses and connects their direct native adapters. Each harness uses your existing model configuration and credential home; cloud accounts only need a fresh sign-in if they cannot be verified. Sign-in and runtime status are also available in Settings → Provider connections.

```sh
loop
loop start --project /absolute/path/to/project
```

Each harness keeps its native tools and context. Agents owned by the same user on one Loop server can discover, message and hand work to one another across harnesses, with shared file references and durable delivery receipts. Team managers can also delegate work. Antigravity currently supports individual conversations; see its [setup and limitations](docs/harnesses.md#antigravity). Inspect threads and resume held messages from each profile’s Agent mail tab. Codex, Claude Code, Pi and Muse Code support live steering; OpenCode, Antigravity, Grok Build and ACP queue follow-ups.

The workspace and pairing are available while each harness is verified independently. Missing harnesses are not installed automatically. A failed account check leaves that harness unavailable without blocking the others.

Use `loop start --providers codex,claude,pi` to limit discovery. Explicit `loop codex|claude|pi|opencode|antigravity|muse|grok|acp` commands support custom executables and native options. Use the Docker companion or server Compose stack for container execution. See [harnesses](docs/harnesses.md) for billing and connection recovery.

Manage OpenCode and Pi provider credentials from **Settings → Provider connections → Harnesses → Manage providers**. Add an OpenRouter or OpenAI key, or use a provider's sign-in flow, and Loop refreshes that harness's model choices. Keys stay in each harness's native store. See [model provider settings](docs/harnesses.md#opencode-and-pi-model-providers).

## Use local models

Use Pi or OpenCode connected to a local model server, such as Ollama, LM Studio or llama.cpp. Loop uses the harness's existing model configuration, so a local-model agent does not require a paid model API or subscription.

1. Start your local model server and load a model suitable for tool use and coding.
2. Configure and select that model in [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md) or [OpenCode](https://opencode.ai/docs/providers/). Confirm it works in the harness's CLI first.
3. From your project directory, connect that harness to Loop:

   ```sh
   loop pi
   # Or, if you use OpenCode:
   loop opencode
   ```

4. In Loop, create an agent using that harness's connection. Select your local model from its model catalog, or use `native-default` to follow the harness's default.

Keep the model server running and reachable from the computer or container running the harness. Pi and OpenCode retain their native tools and conversation context; Loop provides the same phone workspace and result feed.

## Pair your phone

1. Start a laptop workspace with `loop start` and scan its QR code with your phone's camera.
2. Create an agent with an enabled connection and project. The computer must stay awake; work continues when the phone disconnects.
3. If the Quick Tunnel address changes (after `loop stop` or a reboot, not after `loop restart`), run `loop pair` and scan again with your phone’s camera.

```sh
loop status
loop pair
loop logs --follow
loop stop
```

The paired app shows agents and conversations from your computer and connected local Loop Docker servers in one Feed. Choose each new agent's destination in **Model & connection**; every agent shows where it runs. See [unified agents and Feed](docs/pairing.md#unified-agents-and-feed).

To update a checkout install, run `git pull` and `bash install` while Loop keeps running, then `loop restart`. `loop restart` replaces only the application: a separate connection service keeps cloudflared, the Quick Tunnel address and your paired phone, and the restarted application uses the same projects, runtimes, execution and billing settings. It refuses while runs are active unless you pass `--force`. With the login service installed, `loop restart` restarts the application service the same way.

`loop upgrade` does this in one command from any directory: it installs the package from the repository's remote `main` (or `--from PACKAGE`) while Loop keeps running, then restarts into the new build at the same address. A failed install leaves the running workspace alone. It does not use or modify a local Loop checkout. `loop stop` stops everything, including the tunnel; the next start can get a new address. Upgrading from a release without the connection service changes the address once; see [restart and upgrade](docs/pairing.md#connection-service-one-address-across-restarts).


Pairing is for laptop workspaces; the server uses its own access configuration. See [pairing and recovery](docs/pairing.md).

## Develop and contribute

```sh
npm run build
npm run test:all
```

See [development and verification](docs/development.md) for browser, packaging and container checks. Automated harness fixtures verify Loop's behavior; they do not establish authenticated provider compatibility or physical-phone acceptance.

Try an experiment before merging with `loop preview create NAME`. It creates a separate branch and paired design workspace with sample data. Use `loop preview rebuild NAME` as you iterate, or `--mode working` for a full runtime preview. See [experiment previews](docs/previews.md).

Use the [documentation index](docs/README.md) for detailed guides and [AGENTS.md](AGENTS.md) for task-specific contributor context.

## Security

Pairing is how a device signs in; the tunnel address alone grants nothing. Treat pairing links and QR codes like passwords, and revoke unfamiliar devices with `loop devices revoke ID`. [SECURITY.md](SECURITY.md) covers the security model, server access and how to report a vulnerability.

## Build from source

The CLI supports macOS/Linux and declares Node >=22.19. The build produces the web app and `dist/cli.js`.

```sh
git clone https://github.com/j-asefa/loop.git loop
cd loop
npm ci
npm run build
```

Run `bash install` from the checkout to build and create the `loop` command. For a portable installation instead, run `npm pack` and install the resulting tarball with `npm install -g /path/to/loop-0.1.0.tgz`. Without linking or installing, invoke the CLI directly as `node dist/cli.js <command>`.

## Run with Docker and pair your phone

Use `docker compose -f compose.companion.yaml up --build -d`, then `docker compose -f compose.companion.yaml exec loop-companion loop pair`. No host Node installation or server `.env` is needed. See [Docker companion pairing](docs/pairing.md#docker-companion) for persistent state, runtime scope and management commands.

## License

Loop is licensed under the [Apache License 2.0](LICENSE). Dependencies retain their upstream licenses.
