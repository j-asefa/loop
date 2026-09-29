# Loop

Loop is a mobile-first agent platform. Open Loop in your phone's browser and add it to your home screen, then pair it with a workspace running on your computer. Start conversations, run coding harnesses, and manage projects, files, search, teams and workflows from your phone. Agents keep working on your computer after your phone disconnects — reopen Loop anytime to check progress, steer a run or approve the next step. The same workspace UI also runs on desktop, and agents run through provider API connections, server subscription runtimes, or native coding harnesses on your computer.

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

Install and sign in to the harness on your computer first. To pair the phone before choosing a harness, run `loop start` in your project directory. In **New agent**, choose or enable a runtime on this computer, select its project and billing policy, then create an agent. `loop start` leaves the workspace running in the background; `loop pair` issues another code for that workspace. See [start and runtime selection](docs/companion/START-PAIR.md).

You can also enable a harness from the terminal:

```sh
loop codex --project /absolute/path/to/project
loop pi --project /absolute/path/to/project
loop claude --billing existing --project /absolute/path/to/project
loop opencode --billing existing --project /absolute/path/to/project
loop acp --executable /absolute/path/to/agent --billing existing
```

These commands share one local workspace, return after startup, and keep it running in the background. `--local-only` skips the tunnel for desktop testing. `--billing existing` uses the harness's account configuration and may incur API charges. See [harnesses and the managed launcher](docs/harnesses.md) for supported versions, billing checks, ACP arguments and native/Docker execution.

`loop start` starts a workspace without requiring a harness. To use the managed HAPI launcher, run `loop start --providers both --execution native` (or choose `docker` or `both`). Bare `loop` is an alias for `loop start`.

## Pair your phone

1. Start a laptop workspace with `loop start` and scan its QR code with your phone's camera, or use the native Loop app.
2. Create an agent with an enabled connection and project. The computer must stay awake; work continues when the phone disconnects.
3. If the Quick Tunnel address changes, run `loop pair` and scan again in the app. A stable hostname preserves reconnection across restarts.

```sh
loop status
loop pair
loop logs --follow
loop stop
```

To update and restart a manually launched workspace, run `loop stop`, update the checkout with `git pull`, run `bash install`, then run `loop start`. There is no separate `loop restart` command. If you installed the login service, stop it before rebuilding, then start it again with `systemctl --user stop loop.service` and `systemctl --user start loop.service` on Linux, or `launchctl bootout gui/$(id -u)/dev.loop.workspace` and `loop service install` on macOS. A Quick Tunnel URL may change after restart; run `loop pair` to reconnect your phone.

Pairing is for laptop workspaces; the server uses its own access configuration. See [pairing and recovery](docs/pairing.md).

## Build the optional native phone app

```sh
cd mobile
npm ci
npm run typecheck
npm run ios       # macOS with Xcode
# or: npm run android  # Android SDK/emulator or connected device
```

The Expo shell loads the web app from your paired computer and stores the pairing token securely. [Mobile setup](mobile/README.md) covers bundle exports, EAS builds and installation.

## Develop and contribute

```sh
npm run build
npm run test:all
```

See [development and CI](docs/development.md) for browser, mobile, packaging and container checks. Automated harness fixtures verify Loop's behavior; they do not establish authenticated provider compatibility or physical-phone acceptance.

Use the [documentation index](docs/README.md) for detailed guides and [AGENTS.md](AGENTS.md) for task-specific contributor context.

## Build from source

The CLI supports macOS/Linux and declares Node >=22.19. The build produces the web app and `dist/cli.js`.

```sh
git clone https://github.com/j-asefa/loop.git
cd loop
npm ci
npm run build
```

Run `bash install` from the checkout to build and create the `loop` command. For a portable installation instead, run `npm pack` and install the resulting tarball with `npm install -g /path/to/loop-0.1.0.tgz`. Without linking or installing, invoke the CLI directly as `node dist/cli.js <command>`.
