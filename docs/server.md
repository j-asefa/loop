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

Use Settings → Provider connections to connect server subscription accounts through the configured runtime broker, or register a native host. See [remote runtimes](remote-runtimes.md). The root Compose stack supplies the server and subscription runtime; the paired Docker companion is a separate deployment.

Direct subscription connections retired by migration 067 become eligible for native verification in migration 071. Check the account before running work again. Stored history and uncertain dispatch receipts remain intact and are never automatically replayed.

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

For remote single-user access, put an authenticated HTTPS gateway before the private app port. Set `LOOP_URL` and a private `LOOP_GATEWAY_TOKEN` of at least 32 characters. The gateway must authenticate visitors and overwrite `X-Loop-Gateway-Token`; never expose this token to browser code. Forwarding headers alone do not grant access. The gateway must consume its own
`Authorization` credentials (for example Basic authentication) before forwarding
browser traffic. Loop reserves that header for scoped integration credentials:
requests carrying it do not fall back to browser/device sessions and can only
reach their designated API routes. Preserve a Cards bearer header only when the
request is intentionally using the [Cards integration boundary](cards-api.md#integration-tokens);
never copy a gateway credential into browser code or a forwarded app request.

For Loop-managed sign-in with bundled Caddy, configure `.env`:

```dotenv
LOOP_AUTH_MODE=multi-user
LOOP_HOST=loop.example.com
LOOP_URL=https://loop.example.com
LOOP_BEHIND_PROXY=1
```

Point the hostname at the host, then run `docker compose --profile https up --build -d`. Caddy exposes 80/443; keep Loop's direct port private. `LOOP_BEHIND_PROXY` assumes a trusted proxy replaces client-IP headers; it does not authenticate visitors. Compose's loopback-proxy allowance must remain paired with local-only publication for single-user access.

## Archive deployment backups

Deployments that keep a full `workspace-backup` in each
`main-YYYYMMDDTHHMMSSZ-COMMIT` release directory can compress older backups with
the shipped [deployment archiver](../deployment/archive-backups.py). It requires
Python 3.9+ on Linux or macOS and no third-party Python packages. Run it only
after the deployment has finished writing its backups; those directories must
remain immutable while archival runs.

```sh
python3 deployment/archive-backups.py --releases "$HOME/releases" --dry-run
python3 deployment/archive-backups.py --releases "$HOME/releases"
```

The default keeps the newest three expanded backups; `--keep-unpacked N`
changes that count (minimum one). Older backups become
`workspace-backup.tar.gz` in the same release directory. Every file's contents,
permissions and ownership, directory entries, and symlink targets are verified
before the expanded copy is removed. A partial write can be retried; a corrupt
or mismatched existing archive fails with the source backup retained. Backup
directories referenced by another release's symlink stay expanded, and
symlinked release directories are skipped. An exclusive lock prevents two
archivers from changing the same release root at once. `--dry-run` writes
nothing.

Archives are private (`0600`), and each archived release gets
`BACKUP-RESTORE.txt`. To restore, first ensure no `workspace-backup` directory
already exists in that release, then run this from the release directory:

```sh
tar -xzf workspace-backup.tar.gz
```

This retains all backup history. Compression reduces its size; it does not
provide a fixed storage cap or prune source checkouts, dependencies, images or
live workspace data. Keep independent backups as required for host loss.

Add the archiver to the deployment's post-success hook, outside the Loop server
process. Pass the release root explicitly and use the helper from that deployed
revision; it is also included in npm packages under `deployment/`. On systemd
hosts, a user service can run it with `Nice=10`, `CPUQuota=50%`, `IOWeight=10`
and `UMask=0077`. Set `ExecStart` to the absolute Python and helper paths plus
`--releases /absolute/release/root`, then start the service with
`systemctl --user start --no-block loop-archive-backups.service`. The service
journal records completion or verification failures.

The restoration, retention, corruption, interruption and concurrency fixtures
run with `node --test test/deployment-backups.node.test.ts` and are included in
`npm run test:native`. They also require Python 3.9+ and `tar`.
