# Server operation

The server profile runs one shared web application, API and durable worker. Use a persistent Node host or Docker; static hosting alone cannot run it. For QR-based laptop access use [harnesses](harnesses.md) and [pairing](pairing.md).

## Start from a checkout

After `npm ci && npm run build`:

```sh
npm run setup
node --env-file=.env dist/cli.js server
```

This starts the compiled API and worker together in the foreground. The source equivalent is `node --env-file=.env scripts/serve.mjs`, which supervises separate API/worker processes. `npm start` runs only the API and does not load `.env`; `npm run dev` and `npm run worker` load it for their respective source processes.

Open http://localhost:3000. `GET /api/health` reports readiness. [src/server/config.ts](../src/server/config.ts) and [.env.example](../.env.example) define configuration. Setup creates/preserves secrets; do not commit `.env`.

## Docker and subscription connections

```sh
node scripts/setup.mjs
docker compose up --build -d
docker compose logs -f loop runtime-broker
```

The default published port is loopback-only. The private broker controls runtime containers through the Docker socket; the web application and model containers do not receive that socket. `LOOP_RUNTIME_TOKEN` authenticates broker access and identifies its deployment namespace. Preserve it across upgrades.

In Settings → Provider connections, add ChatGPT or Claude, keep Subscription selected, select the runtime machine and follow the provider sign-in flow. A displayed login URL is not a connected account: wait for confirmation. Create an agent with the resulting connection and model. API connections are separate, explicit choices; subscription paths do not fall back to API billing. Provider limits and extra-usage settings still apply.

The Docker broker retains per-connection native credential volumes. Codex operations share a persistent app-server; Claude operations use their own containers. Loop supplies conversation context for managed subscription turns, distinct from direct companion conversations that retain native session context. Native tools run inside these environments; Loop-connected tools follow the workspace approval preference. Disconnect disables new submissions and invokes logout; if the runtime is unreachable, retry to complete logout. Credential volumes are retained and require separate lifecycle management.

[Remote server runtimes](remote-runtimes.md) covers a remote broker, a native host for Codex/Claude and direct Codex app-server. Those modes expose different host access than isolated containers.

### Cleanup after a pull request merges

Managed Docker agents receive a workspace lifecycle instruction: reuse a primary clone, create a linked Git worktree and branch per job, and register each job when opening or taking ownership of a GitHub PR:

```sh
node /runtime/workspace-cleanup.mjs track /home/node/workspaces/AGENT_KEY /home/node/workspaces/AGENT_KEY/job https://github.com/owner/repo/pull/123
```

The server worker checks registered jobs every five minutes when their subscription connection is idle, using the owner's allowed connected GitHub integration. It does not invoke a model. Registration is stored in the agent workspace's `.loop-cleanup` directory, survives restarts, and does not contain credentials. Jobs already on disk must be registered before automatic cleanup can find them. A busy connection is skipped until a later check; new work cannot overlap deletion. Rebuild the app, broker and runtime images together to enable this lifecycle.

Cleanup verifies GitHub's merged status, repository, branch and exact PR head SHA, including squash/rebase merges. It removes ignored, untracked generated directories such as `node_modules`, `dist`, `build`, `coverage`, `.next` and `target`, including nested packages. It then removes a clean linked worktree with `git worktree remove` and deletes the matching local branch. A primary clone is kept for reuse, with its merged branch detached and deleted. Remote branches are separate: GitHub's **Automatically delete head branches** repository setting handles those.

Dirty or locked worktrees, unpushed commits, default/base branches and submodules are preserved. Other ignored files (such as `.env` or user uploads) prevent worktree retirement even after generated files are removed. Failed or blocked checks leave a reason in the registration's `lastResult`; they are retried on later checks. Agents should upload deliverables to Loop before retiring a job. Cleanup never uses blanket `git clean` or forces removal of a worktree. Agents can also run `node /runtime/workspace-cleanup.mjs sweep /home/node/workspaces/AGENT_KEY` when their jobs are idle.

This lifecycle applies to registered managed Docker workspaces, not arbitrary host directories, direct companion sessions, Docker images or build caches. It has no disk quota and does not bound storage growth during active work.

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

This optional server stack runs the private HAPI Hub, runner and memory service locally:

```sh
node scripts/setup.mjs
node deployment/local/setup-native.mjs
docker compose -p loop-local-native -f compose.yaml -f deployment/local/compose.yaml up --build -d
```

Open the workspace and connect the **This laptop** environment in Settings → Provider connections. Sign in using the provider flow. Generated identities are in `.local-native/`; databases, provider homes, projects and indexes also use persistent volumes. The native image uses the platform and versions in [deployment/versions.json](../deployment/versions.json); nonmatching hosts may require emulation.

Stop with `docker compose -p loop-local-native -f compose.yaml -f deployment/local/compose.yaml down`. Omit `-v` to preserve declared volumes. This is separate from the CLI's [managed laptop launcher](harnesses.md#managed-launcher).

## Backups and upgrades

Preserve `BETTER_AUTH_SECRET`, `LOOP_ENCRYPTION_KEY`, the runtime token, application databases and runtime credential volumes. Rotating encryption keys without migration makes stored secrets unreadable. Back up with `npm run backup -- /absolute/backup/loop.db` in a checkout configured for the actual server data directory, or use a consistent SQLite backup inside the deployment. Copying an active WAL database alone is not a valid backup. Back up runtime volumes and project files separately; they are not included in the database backup.

Stop or quiesce the affected deployment before restore. Keep a pre-upgrade backup and use the same profile. Migrations handle the supported application schemas; arbitrary old or unprofiled databases are not a general import format. Verify health and representative account/history access after restarting.
