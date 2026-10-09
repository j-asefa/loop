# Server operation

The server profile runs one shared web application, API and durable worker. Use a persistent Node host or Docker; static hosting alone cannot run it. For QR-based laptop or Docker companion access use [pairing](pairing.md#docker-companion). The dedicated companion Compose file is separate from the server deployment below.

## Start from a checkout

After `npm ci && npm run build`:

```sh
npm run setup
node --env-file=.env dist/cli.js server
```

This starts the compiled API and worker together in the foreground. The source equivalent is `node --env-file=.env scripts/serve.mjs`, which supervises separate API/worker processes. `npm start` runs only the API and does not load `.env`; `npm run dev` and `npm run worker` load it for their respective source processes.

Open http://localhost:3000. `GET /api/health` reports readiness. [src/server/config.ts](../src/server/config.ts) and [.env.example](../.env.example) define configuration. Setup creates/preserves secrets; do not commit `.env`.

## Docker and harness connections

Run the [local HAPI stack](#local-hapi-and-memsearch-stack) for server-side harness execution. In Settings → Execution environments, select a provisioned environment, connect its provider and map the project directory. The runner verifies existing native sign-in before asking for authentication. Docker runners have a separate persistent home; they do not automatically share a laptop's account.

All harness turns go through HAPI. Direct subscription connections, native-host inference and direct Codex app-server connections are retired. Existing conversations and files remain stored; reconnect the agent to its HAPI connection and start a new conversation. Loop does not move native context or replay queued or uncertain legacy work. API-key connections remain separate choices.

The base Compose stack also supplies the private broker for workspace command MCPs. Its Docker socket stays off the web application and model containers. Keep the broker token stable across upgrades. It is not a harness execution alternative.

### Automatic storage maintenance

Every five minutes the server asks idle managed Docker subscription connections to reclaim stale storage, without a model turn or GitHub sign-in. The broker reserves the connection and runs a read-only preflight when a warm runtime exists. It stops that runtime only if storage or a registered checkout is eligible, then repeats verification before deleting anything. New work waits until maintenance finishes; storage inspection has a ten-second budget and the broker limits both preflight and cleanup to sixty seconds. Storage failures are reported independently so registered PR retirement can still run. Each pass checks up to four dependency directories, one Playwright browser installation and 256 npm download blobs, rotating through candidates so a blocked checkout cannot starve the others.

Ignored `node_modules` installations become eligible after 24 hours without an agent turn or filesystem use. Loop requires a clean, unlocked checkout, npm's hidden install receipt matching the project lockfile, registry dependencies, and installed files matching the cached registry package payloads byte for byte. Each payload must match the lockfile's integrity hash; refreshing npm's receipt cannot authorize deletion of edited files. Missing payloads, unsupported archives, added files and generated installation outputs are preserved. It preserves tracked files, local/editable dependencies, unknown layouts, credential files, external links and Bun/pnpm installations. Source, branches, Git history and user outputs stay in place. A later task may need to run `npm ci` again. This also covers old PR/review checkouts without a cleanup registration; merge status is not needed to reclaim verified dependencies.

For caches, npm's SHA-512 content-addressed download blobs unused for seven days are eligible; their contents must match their filenames. Completed Playwright browser installations unused for seven days are also eligible if they contain no later file changes or external links. npm refetches missing package downloads; browser tasks may need `npx playwright install` again. Loop keeps cache indexes, unknown/model caches, provider homes, credentials and conversations. It never blanket-deletes `.cache`. Last inspection results and reasons are stored in the private connection home at `.loop-storage/last-result.json`.

Storage maintenance applies to managed Docker subscription homes, including legacy connections explicitly retired by HAPI migration and still referenced by their agents; user-disconnected connections are excluded. It excludes connections backed by HAPI, arbitrary host projects, companion sessions, images and Docker build caches. Moving an agent to another connection does not transfer or sweep its old home. Rebuild the app and runtime images to enable it. This is age-based reclamation, not a hard quota; active work can still consume disk space.

### Cleanup after a pull request merges

Legacy managed Docker agents registered jobs when opening or taking ownership of a GitHub PR, using a primary clone and a linked Git worktree and branch per job. Those registrations remain eligible for cleanup after HAPI migration:

```sh
node /runtime/workspace-cleanup.mjs track /home/node/workspaces/AGENT_KEY /home/node/workspaces/AGENT_KEY/job https://github.com/owner/repo/pull/123
```

The server worker checks registered jobs every five minutes when their subscription connection is idle, using the owner's allowed connected GitHub integration. It does not invoke a model. Registration is stored in the agent workspace's `.loop-cleanup` directory, survives restarts, and does not contain credentials. Jobs already on disk must be registered before automatic cleanup can find them. A busy connection is skipped until a later check; new work cannot overlap deletion. Rebuild the app, broker and runtime images together to enable this lifecycle.

Cleanup verifies GitHub's merged status, repository, branch and exact PR head SHA, including squash/rebase merges. Storage maintenance can first remove eligible dependencies. Checkout retirement removes only empty ignored generated directories: populated build/output folders remain for review because they may contain user files. Once no ignored files remain, it removes a clean linked worktree with `git worktree remove` and deletes the matching local branch. A primary clone is kept for reuse, with its merged branch detached and deleted. Remote branches are separate: GitHub's **Automatically delete head branches** repository setting handles those.

Dirty or locked worktrees, unpushed commits, default/base branches and submodules are preserved. Other ignored files (such as `.env` or user uploads) prevent worktree retirement even after generated files are removed. Failed or blocked checks leave a reason in the registration's `lastResult`; they are retried on later checks. Agents should upload deliverables to Loop before retiring a job. Cleanup never uses blanket `git clean` or forces removal of a worktree. Agents can also run `node /runtime/workspace-cleanup.mjs sweep /home/node/workspaces/AGENT_KEY` when their jobs are idle.

PR retirement applies only to registered jobs; dependency and cache maintenance above works independently of PR registration and GitHub access.

## Access configuration

| Setting                      | Use                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `LOOP_AUTH_MODE=single-user` | Default personal workspace; direct access restricted to local requests or a trusted gateway |
| `LOOP_AUTH_MODE=multi-user`  | Loop sign-in and separate owner-scoped workspaces                                           |
| `LOOP_SINGLE_USER_EMAIL`     | Explicit owner selection when several existing accounts are present                         |
| `LOOP_URL`                   | Actual browser origin, used for access/origin checks                                        |
| `LOOP_LISTEN_HOST`           | Direct Node listener; defaults to `127.0.0.1`                                               |
| `LOOP_BIND_ADDRESS`          | Compose published interface; defaults to `127.0.0.1`                                        |
| `LOOP_DATA_DIR`              | Persistent server data; defaults to `./data`                                                |

Changing authentication mode does not merge users' data. A database records its deployment profile; never point server and companion deployments at the same data directory.

For remote single-user access, put an authenticated HTTPS gateway before the private app port. Set `LOOP_URL` and a private `LOOP_GATEWAY_TOKEN` of at least 32 characters. The gateway must authenticate visitors and overwrite `X-Loop-Gateway-Token`; never expose this token to browser code. Forwarding headers alone do not grant access.

For Loop-managed sign-in with bundled Caddy, configure `.env`:

```dotenv
LOOP_AUTH_MODE=multi-user
LOOP_HOST=loop.example.com
LOOP_URL=https://loop.example.com
LOOP_BEHIND_PROXY=1
```

Point the hostname at the host, then run `docker compose --profile https up --build -d`. Caddy exposes 80/443; keep Loop's direct port private. `LOOP_BEHIND_PROXY` assumes a trusted proxy replaces client-IP headers; it does not authenticate visitors. Compose's loopback-proxy allowance must remain paired with local-only publication for single-user access.

## Local HAPI and MemSearch stack

This server stack runs the private HAPI Hub, runner and memory service locally:

```sh
node scripts/setup.mjs
node deployment/local/setup-native.mjs
docker compose -p loop-local-native -f compose.yaml -f deployment/local/compose.yaml up --build -d
```

Open Settings → Execution environments and select the provisioned environment. Connect a provider using its existing runner account, or use the provider sign-in flow if needed. Generated identities are in `.local-native/`; databases, provider homes, projects and indexes also use persistent volumes. The native image uses the platform and versions in [deployment/versions.json](../deployment/versions.json); nonmatching hosts may require emulation.

Stop with `docker compose -p loop-local-native -f compose.yaml -f deployment/local/compose.yaml down`. Omit `-v` to preserve declared volumes. This is separate from the CLI's [managed laptop launcher](harnesses.md#managed-launcher).

### Subscription usage on a managed HAPI runner

In Settings → Execution environments, open a managed environment and select **Read subscription usage**. Loop asks that environment's authenticated worker for a fresh Codex rate-limit reading and its latest Claude Code rate-limit sample. The read stays scoped to the environment owner; the browser receives percentages and reset times, never provider credentials. Codex uses the worker's existing shared app-server and does not start another Codex process.

When the managed runner starts, it adds a Claude Code status-line command to its user settings if there is no existing status line. Claude Code supplies five-hour and seven-day percentages to that command after a supported session update; the worker stores only those values and their observation time. An existing status line is preserved, so it must invoke `native/claude-usage-hook.mjs` itself to collect samples. Claude samples can be absent or stale, especially if a headless HAPI session does not invoke status-line commands. The UI shows the sample time and reports missing samples instead of treating them as a live account query. Rebuild the native image and app together to enable this feature.

## Backups and upgrades

Preserve `BETTER_AUTH_SECRET`, `LOOP_ENCRYPTION_KEY`, the runtime token, application databases and runtime credential volumes. Rotating encryption keys without migration makes stored secrets unreadable. Back up with `npm run backup -- /absolute/backup/loop.db` in a checkout configured for the actual server data directory, or use a consistent SQLite backup inside the deployment. Copying an active WAL database alone is not a valid backup. Back up runtime volumes and project files separately; they are not included in the database backup.

Stop or quiesce the affected deployment before restore. Keep a pre-upgrade backup and use the same profile. Migrations handle the supported application schemas; arbitrary old or unprofiled databases are not a general import format. Verify health and representative account/history access after restarting.
