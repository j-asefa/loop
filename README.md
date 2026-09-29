# Loop

Loop is a mobile-first agent platform. Pair the Loop app on your phone to a workspace running on your computer or a server, then start conversations, run coding harnesses, and manage projects, files, search, teams and workflows from your phone. Agents keep working on your computer after your phone disconnects — reopen the app anytime to check progress, steer a run or approve the next step. The same workspace UI also runs on desktop, and agents run through provider API connections, server subscription runtimes, or native coding harnesses on your computer.

## Setup

Use Node.js **24** (the CI version) and a persistent disk. Docker is required only for container execution.

```sh
git clone https://github.com/j-asefa/loop.git
cd loop
npm ci
npm run build
npm link
```

`npm link` puts a `loop` command on your PATH so the examples below work as-is. Prefer not to link? Run `node dist/cli.js <command>` instead everywhere you see `loop <command>`.

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

Install and sign in to the harness on your computer first, then run one of:

```sh
loop codex --project /absolute/path/to/project
loop pi --project /absolute/path/to/project
loop claude --billing existing --project /absolute/path/to/project
loop opencode --billing existing --project /absolute/path/to/project
loop acp --executable /absolute/path/to/agent --billing existing
```

These commands share one local workspace, return after startup, and keep it running in the background. `--local-only` skips the tunnel for desktop testing. `--billing existing` uses the harness's account configuration and may incur API charges. See [harnesses and the managed launcher](docs/harnesses.md) for supported versions, billing checks, ACP arguments and native/Docker execution.

Plain `loop` starts the managed laptop launcher: choose OpenAI, Anthropic or both, and native, Docker or both. This launcher provisions its own HAPI services; it differs from selecting an installed harness directly.

## Pair your phone

1. Start a laptop workspace and scan its QR code in the Loop app, or open the pairing link in a browser and confirm pairing.
2. Create an agent with an enabled connection and project. The computer must stay awake; work continues when the phone disconnects.
3. If the Quick Tunnel address changes, run `loop pair` and scan again in the app. A stable hostname preserves reconnection across restarts.

```sh
loop status
loop pair
loop logs --follow
loop stop
```

Pairing is for laptop workspaces; the server uses its own access configuration. See [pairing and recovery](docs/pairing.md).

## Build the phone app

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

For a `loop` command on your PATH, run `npm link`. For a portable installation instead, run `npm pack` and install the resulting tarball with `npm install -g /path/to/loop-0.1.0.tgz`. Without linking or installing, invoke the CLI directly as `node dist/cli.js <command>`.
