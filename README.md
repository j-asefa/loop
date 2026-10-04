# 🔁 Loop

Loop is a phone-first agent web app. Open Loop in your phone's browser and add it to your home screen, then pair it with a workspace running on your computer. Start conversations, run coding harnesses, and manage projects, files, search, teams and workflows from your phone. The same workspace UI also runs on desktop, and agents run through provider API connections, server subscription runtimes, or native coding harnesses on your computer.

## Why Loop

- 📲 **No app to install.** Scan a QR code, pair in your phone's browser and add Loop to your home screen. The same flow works on iPhone and Android, with no app store or account signup. A Quick Tunnel gives your computer an HTTPS address with no domain, router or account setup; if the address changes, run `loop pair` and scan again. On iPhone, notifications work once Loop is on your home screen. See [pairing](docs/pairing.md).
- 🎯 **Results, not logs.** Final answers appear as cards; plans, diffs, command output and traces stay one tap away. Search an agent's traces for a command, tool or update, and download a whole run as JSON. Phone notifications arrive when a result is ready, not for every tool call. See [notifications](docs/feedback/SAVED-NOTIFICATIONS.md).
- 🗂️ **A feed, not one endless chat.** Run several agents and conversations at once, then follow them through the Feed (**Done**, **Needs you**, **Working**, **Queued**), Projects and Search. Review and merge your GitHub pull requests in the Pull requests tab. Saved results and messages live under You. See [workspace](docs/workspace.md).
- ⏱️ **Built for checking in, not sitting in.** Each Feed card offers the one action its thread is waiting for (approve, answer, continue a draft or review a result) and opens at that message. A "while you were away" card sums up what finished, failed or needs you. **Remind me**, **Send later** and **Queue after this task** pick work up when the agent is free, and scheduled sends reuse their idempotency key, so a retry after a crash never sends twice.
- ↩️ **Reply to any message, or just part of it.** Loop quotes the message you picked, or only the lines you highlight, in front of your reply. Intermediate updates may be missing from the harness's own history, so this puts that exact update back in front of the agent. Long quotes are trimmed to their start and end. Mid-run, Codex, Claude Code and API agents take your reply in the live turn; HAPI-managed, Pi, OpenCode and ACP sessions queue it for the next turn.
- 🔌 **Your harnesses, your subscriptions.** Codex, Claude Code, OpenCode, Pi and ACP agents keep their own context, tools and sign-in. By default `loop start` runs them through a managed HAPI runner; Loop adds the phone workspace on top: the Feed, result cards, quoted replies, reminders, scheduled sends and approvals across every harness. Loop checks the billing policy you chose and never switches billing methods after a failure. See [harnesses](docs/harnesses.md).
- 📶 **Built for flaky phone connections.** Loop records each send before dispatching it, never automatically replays an uncertain one, and catches up on missed updates after a reconnect. See [architecture](docs/architecture.md).
- 🏠 **Your code stays on your computer.** Agents run on your machine and keep working after your phone disconnects; reopen Loop to check progress, steer a run or approve the next step. Only paired devices can sign in, and you can revoke them. Traffic is HTTPS but not end-to-end encrypted: with the default Quick Tunnel, Cloudflare terminates TLS, so use `--public-url` with your own TLS proxy if that matters to you. See [SECURITY.md](SECURITY.md).

## Setup

Use Node.js **24** (the CI version) and a persistent disk. Docker is required only for container execution.

```sh
git clone https://github.com/j-asefa/loop.git
cd loop
bash install
loop start
```

The installer runs `npm ci`, builds Loop and links `loop` into a writable directory on your PATH. If none is writable, it uses `~/.local/bin` and prints the PATH command needed for your shell. Keep the checkout in place while using this installation.

## Install on your phone

1. In the Loop checkout on your computer, run `loop start`. It starts the workspace and displays a pairing QR code.
2. Scan the QR code with your phone's camera. The link opens Loop's pairing page in your default mobile browser. Tap **Pair and open Loop**.
3. In the browser, open **Share** and choose **Add to Home Screen**. On Android browsers, this may appear as **Install app** or **Add to Home screen** in the browser menu.
4. Open Loop from the new home screen icon.

The computer must stay awake for phone access. Pairing links are single use and expire after two minutes; run `loop pair` for a fresh code. If the Quick Tunnel address changes, scan a new code and add the new page to your home screen. See [pairing and recovery](docs/pairing.md).

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

See [server operation](docs/server.md) for accounts, remote access, runtime machines, backups and the local HAPI/MemSearch stack.

## Use a coding harness

Install the harness on your computer, then run `loop start` in your project directory. In **New agent**, choose a runtime, sign in to its provider, select its project and billing policy, and enable it before creating an agent. Provider sign-in is also available in Settings → Provider connections. `loop start` leaves the workspace running in the background; `loop pair` issues another code for that workspace. See [native provider sign-in](docs/harnesses.md#provider-sign-in) and [start and runtime selection](docs/companion/START-PAIR.md).

You can also enable a harness from the terminal:

```sh
loop codex --project /absolute/path/to/project
loop pi --project /absolute/path/to/project
loop claude --billing existing --project /absolute/path/to/project
loop opencode --billing existing --project /absolute/path/to/project
loop acp --executable /absolute/path/to/agent --billing existing
```

These commands share one local workspace, return after startup, and keep it running in the background. `--local-only` skips the tunnel for desktop testing. `--billing existing` uses the harness's account configuration and may incur API charges. See [harnesses and the managed launcher](docs/harnesses.md) for supported versions, billing checks, ACP arguments and native/Docker execution.

Without explicit flags or saved preferences, `loop start` prepares Codex, Claude Code, OpenCode and Pi through one native HAPI runner, installing missing runtimes privately. Pairing stays available during setup; a preparation failure retains direct runtime access. Use `loop start --direct` to skip managed preparation. Explicit options and saved preferences take precedence. Bare `loop` is an alias for `loop start`.

**First-start change:** Automatic managed setup builds pinned HAPI and guarded OpenCode from source on a laptop and can take several minutes with network access and build tools. This automatic choice is not saved as a preference. Use `loop start --providers codex,claude,pi --execution native` to omit the OpenCode build, or `--direct` to skip managed setup. The companion Docker image prepares these artifacts at image build time.

## Pair your phone

1. Start a laptop workspace with `loop start` and scan its QR code with your phone's camera.
2. Create an agent with an enabled connection and project. The computer must stay awake; work continues when the phone disconnects.
3. If the Quick Tunnel address changes, run `loop pair` and scan again with your phone’s camera.

```sh
loop status
loop pair
loop logs --follow
loop stop
```

To update and restart a manually launched workspace, run `loop stop`, update the checkout with `git pull`, run `bash install`, then run `loop start`. There is no separate `loop restart` command. If you installed the login service, stop it before rebuilding, then start it again with `systemctl --user stop loop.service` and `systemctl --user start loop.service` on Linux, or `launchctl bootout gui/$(id -u)/dev.loop.workspace` and `loop service install` on macOS. A Quick Tunnel URL may change after restart; run `loop pair` to reconnect your phone.

`loop upgrade` performs that update flow in one command from any directory: it installs the package from the repository's remote `main`, rebuilds and reinstalls the CLI, then restarts Pi with the existing workspace state. It does not use or modify a local Loop checkout. The restart preserves workspace data and paired devices, but a Quick Tunnel URL may change, so scan the fresh pairing link it prints.

Pairing is for laptop workspaces; the server uses its own access configuration. See [pairing and recovery](docs/pairing.md).

## Develop and contribute

```sh
npm run build
npm run test:all
```

See [development and CI](docs/development.md) for browser, packaging and container checks. Automated harness fixtures verify Loop's behavior; they do not establish authenticated provider compatibility or physical-phone acceptance.

Use the [documentation index](docs/README.md) for detailed guides and [AGENTS.md](AGENTS.md) for task-specific contributor context.

## Security

Pairing is how a device signs in; the tunnel address alone grants nothing. Treat pairing links and QR codes like passwords, and revoke unfamiliar devices with `loop devices revoke ID`. [SECURITY.md](SECURITY.md) covers the security model, server access and how to report a vulnerability.

## Build from source

The CLI supports macOS/Linux and declares Node >=22.19. The build produces the web app and `dist/cli.js`.

```sh
git clone https://github.com/j-asefa/loop.git
cd loop
npm ci
npm run build
```

Run `bash install` from the checkout to build and create the `loop` command. For a portable installation instead, run `npm pack` and install the resulting tarball with `npm install -g /path/to/loop-0.1.0.tgz`. Without linking or installing, invoke the CLI directly as `node dist/cli.js <command>`.

## Run with Docker and pair your phone

Use `docker compose -f compose.companion.yaml up --build -d`, then `docker compose -f compose.companion.yaml exec loop-companion loop pair`. No host Node installation or server `.env` is needed. See [Docker companion pairing](docs/pairing.md#docker-companion) for persistent state, runtime scope and management commands.
