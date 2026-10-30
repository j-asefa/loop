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

Forward WebSocket upgrades for `/api/events/ws` through any reverse proxy, with the same session cookies or trusted gateway header as ordinary requests. See [workspace updates](architecture.md#workspace-updates) for push updates and polling recovery.

For integration streams, forward WebSocket upgrades and the `Authorization` header for `/api/events/stream`. Acknowledgements travel on the same socket. The endpoint checks token authority and sends a ping every 25 seconds while idle; server and companion shutdown terminate its sockets. It uses WebSockets for compatibility with the default Quick Tunnel connection; see [Integration API events](cards-api.md#event-pages-and-streaming).

## Docker and harness connections

Use Settings → Provider connections to connect server subscription accounts through the configured runtime broker, or register a native host. See [remote runtimes](remote-runtimes.md). The root Compose stack supplies the server and subscription runtime; the paired Docker companion is a separate deployment.

Direct subscription connections retired by migration 067 become eligible for native verification in migration 071. Check the account before running work again. Stored history and uncertain dispatch receipts remain intact and are never automatically replayed.

## Access configuration

| Setting                      | Use                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `LOOP55_AUTH_MODE=single-user` | Default personal workspace; direct access restricted to local requests or a trusted gateway |
| `LOOP55_AUTH_MODE=multi-user`  | Loop55 sign-in and separate owner-scoped workspaces                                           |
| `LOOP55_SINGLE_USER_EMAIL`     | Explicit owner selection when several existing accounts are present                         |
| `LOOP55_URL`                   | Actual browser origin, used for access/origin checks                                        |
| `LOOP55_LISTEN_HOST`           | Direct Node listener; defaults to `127.0.0.1`                                               |
| `LOOP55_BIND_ADDRESS`          | Compose published interface; defaults to `127.0.0.1`                                        |
| `LOOP55_DATA_DIR`              | Persistent server data; defaults to `./data`                                                |

Changing authentication mode does not merge users' data. A database records its deployment profile; never point server and companion deployments at the same data directory.

For remote single-user access, put an authenticated HTTPS gateway before the private app port. Set `LOOP55_URL` and a private `LOOP55_GATEWAY_TOKEN` of at least 32 characters. The gateway must authenticate visitors and overwrite `X-Loop55-Gateway-Token`; never expose this token to browser code. Forwarding headers alone do not grant access. The gateway must consume its own
`Authorization` credentials (for example Basic authentication) before forwarding
browser traffic. Loop55 reserves that header for scoped integration credentials:
requests carrying it do not fall back to browser/device sessions and can only
reach their designated API routes. Preserve a Cards bearer header only when the
request is intentionally using the [Cards integration boundary](cards-api.md#integration-tokens);
never copy a gateway credential into browser code or a forwarded app request.

For Loop55-managed sign-in with bundled Caddy, configure `.env`:

```dotenv
LOOP55_AUTH_MODE=multi-user
LOOP55_HOST=loop55.example.com
LOOP55_URL=https://loop55.example.com
LOOP55_BEHIND_PROXY=1
```

Point the hostname at the host, then run `docker compose --profile https up --build -d`. Caddy exposes 80/443; keep Loop55's direct port private. `LOOP55_BEHIND_PROXY` assumes a trusted proxy replaces client-IP headers; it does not authenticate visitors. Compose's loopback-proxy allowance must remain paired with local-only publication for single-user access.

## Keep agent workloads from exhausting the server

On a Linux host with systemd and cgroup v2, set `LOOP55_NATIVE_LAUNCHER` to the
absolute path of [agent-scope.py](../deployment/agent-scope.py). Native Codex,
Claude, Pi, OpenCode and ACP-family harnesses enter a separate resource group
before execution. Their test workers, builds and other child processes inherit
the group, while the Loop55 API and execution coordinator stay outside it. The
launcher preserves protocol pipes (including metadata on descriptor 3), process
identity, working directory and native credentials. Placement failure refuses
the launch instead of running it without limits.

For an 8 GiB, four-CPU host using the user service `loop55.service`:

```sh
bash deployment/install-agent-resources.sh loop55.service
# After active runs finish:
systemctl --user restart loop55.service
```

The installer sets `LOOP55_HEAVY_SCHEDULING=off` for new harnesses so tests in
older worktrees bypass their removed shared-slot limiter. It also retires installed
automatic queue wrappers and removes their service settings; see [command supervision](development.md#command-supervision).

The installer copies the launcher and installs
[loop55-agents.slice](../deployment/loop55-agents.slice): all native agent processes
together have a 5 GiB hard memory ceiling,
at most 1 GiB of swap and three CPUs. This leaves capacity for Loop55 and the OS;
it is an aggregate limit, not a fresh allowance for each agent. There is no
lower `MemoryHigh` threshold: early reclaim can otherwise stall all harnesses
even while the server's reserved capacity is free. A workload that
exhausts the ceiling can have its processes killed by the kernel; Loop55 must
report that failure and never automatically replay an uncertain action.

Adjust `~/.config/systemd/user/loop55-agents.slice` for the host's capacity. Run the
installer after upgrades to refresh the helper; it preserves an existing slice
configuration and never restarts the service. Inspect `systemctl --user show
loop55-agents.slice -p MemoryCurrent -p MemoryPeak -p MemoryMax` and the scope's
`memory.events` to diagnose pressure or a resource kill. This is resource
isolation, not a security boundary for an OS user with authority to change its
own units. Docker containers and external execution services need their own
resource limits because their processes are created by another service.

Loop55 observes out-of-memory kills in each native launch's dedicated resource
scope. When a kill precedes the native process exiting, its failure card reports
the memory limit, when available, and suggests reviewing saved progress before
retrying with fewer builds or tests running. Startup failures also say when no
prompt was sent. This diagnosis requires per-launch Linux cgroup evidence;
another agent's memory kill, a startup timeout, or `SIGKILL` alone does not prove
that this run ran out of memory. Raw process output and credentials are never
used to compose this message. Monitoring does not change resource limits or
automatically retry work.

Database liveness heartbeats use a nonblocking write. If another process owns
SQLite's write lock, the timestamp remains unchanged and the next timer tries
again; stale observations still expire. Contention cannot terminate the server
through those timer callbacks. Ordinary writes retain their normal timeout and
error behavior.

## Queue commands explicitly

Tests, builds and typechecks do not wait for a shared host slot. Loop55 does not inject queue wrappers into native harness command PATHs. To retire wrappers installed by an earlier release on Linux or macOS, run:

```sh
node deployment/remove-job-shims.mjs
```

This replaces only recognized Loop55 `node`, `npm` and `npx` wrappers with direct shell execs, preserving paths still held by active terminals, their process IDs and protocol pipes. It clears obsolete admission settings for those commands. It does not stop or replay already submitted jobs. On Linux, the agent resource installer above performs this migration and removes the queue environment variables from the Loop55 service; restart Loop55 to refresh its environment. On macOS, remove old `LOOP55_JOB_QUEUE_CONFIG` and `LOOP55_JOB_SHIMS` assignments from the launch environment too.

If you want to queue a particular command, the optional [Pueue](https://github.com/Nukesor/pueue) integration remains available on Linux and macOS (Node 24, x64 or arm64):

```sh
node deployment/install-job-queue.mjs
~/.local/lib/loop55/job-queue/bin/loop55-job run -- npm run check
~/.local/lib/loop55/job-queue/bin/loop55-job status
```

The installer downloads checksum-verified Pueue 4.0.4 binaries and starts a dedicated per-user daemon. It installs no automatic command wrappers and does not restart Loop55. Configuration lives in `~/.config/loop55/jobs.json` (or `$XDG_CONFIG_HOME/loop55/jobs.json`); queue state and logs live in `~/.local/state/loop55-jobs`. It leaves an existing personal Pueue installation alone. Only explicitly submitted commands share FIFO ordering and one running job by default.

On Linux, explicitly queued jobs run in `loop55-agents-jobs.slice`, with a 3 GiB memory cap, 512 MiB swap and two CPUs, **within** the aggregate 5 GiB agent budget. Ordinary native checks inherit their agent's resource scope. The queue service uses `OOMPolicy=continue`. Adjust the slice files for that host; upgrades preserve those capacity choices. On macOS, the installer creates the `dev.loop55.job-queue` LaunchAgent for the logged-in desktop user; Linux cgroup limits do not apply. A headless Mac needs a suitable launchd user domain configured by its operator.

Use `loop55-job cancel ID` to cancel an explicitly queued command. Inspect `systemctl --user status loop55-job-queue.service` on Linux or `launchctl print gui/$(id -u)/dev.loop55.job-queue` on macOS. A failed daemon does not silently replay commands. Keep long-running development servers and watch sessions outside this finite-command queue. See [command supervision](development.md#command-supervision) for ownership, logs and credential handling.

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

Add the archiver to the deployment's post-success hook, outside the Loop55 server
process. Pass the release root explicitly and use the helper from that deployed
revision; it is also included in npm packages under `deployment/`. On systemd
hosts, a user service can run it with `Nice=10`, `CPUQuota=50%`, `IOWeight=10`
and `UMask=0077`. Set `ExecStart` to the absolute Python and helper paths plus
`--releases /absolute/release/root`, then start the service with
`systemctl --user start --no-block loop55-archive-backups.service`. The service
journal records completion or verification failures.

The restoration, retention, corruption, interruption and concurrency fixtures
run with `node --test test/deployment-backups.node.test.ts` and are included in
`npm run test:native`. They also require Python 3.9+ and `tar`.


## Protect live data from build disk pressure

On a shared development host, builds, package fixtures and deployment copies can
fill the same filesystem used by SQLite. Reserve a separate filesystem for the
**whole `LOOP55_HOME`**, including its workspace, configuration and helpers. A real
volume is preferable; a fully allocated ext4 image also reserves space on a
single-disk host. A sparse image does not reserve capacity. This separates space
budgets, not privileges: a process with access to Loop55 data or root can still
modify it, and the data filesystem itself needs free-space monitoring.

The Linux [reserved-volume helper](../deployment/reserved-volume.py) mounts an
already formatted image using a root-owned JSON configuration with `image`,
`mountpoint`, `bytes` and its filesystem `uuid`. It verifies the backing file is
private, fully allocated and has the expected UUID, refuses to hide an existing
data directory, and disables loop-device discard so inner filesystem trimming
cannot release the reserved blocks. It never formats or migrates data. Configure
a root oneshot systemd service with `RemainAfterExit=yes`, run its `mount` action
before the user manager starts, and use `verify` for checks. Add
`ExecStartPre=/usr/bin/mountpoint -q /absolute/LOOP55_HOME` to Loop55's service so a
failed mount cannot silently start a new workspace on the root disk. Copy data
only after all runs finish and Loop55 stops; verify contents and SQLite integrity
before restarting and removing the old copy.

### Storage budgets and bounded retention

[storage-policy.py](../deployment/storage-policy.py) supplies host-side guards
and retention, independently of the Loop55 process. It requires Linux, Python 3.9+,
OpenSSH and rsync. Copy and adapt
[the example configuration](../deployment/storage-policy.example.json). All
paths must identify the intended user's deployment and backup directories.

```sh
python3 deployment/storage-policy.py guard --config /absolute/storage-policy.json
python3 deployment/storage-policy.py maintain --config /absolute/storage-policy.json --dry-run
python3 deployment/storage-policy.py maintain --config /absolute/storage-policy.json
```

The example requires 20 GiB free on the build filesystem and 4 GiB inside the
reserved data filesystem. Call `guard` before starting a deployment and again
before copying its workspace backup; `--extra-bytes N` adds the estimated staging
space to the build budget. A rejected deployment must leave the running server
alone. Optional PATH wrappers [storage-command.py](../deployment/storage-command.py)
can apply the same check to npm, npx and Docker commands that create data. Set the
underlying absolute executable paths in configuration, install the wrapper as
`npm`, `npx` and `docker` under `~/.local/bin`, and put that directory first in the
service's PATH. Read-only and cleanup commands remain available. These checks
reject new work; they are not quotas and cannot constrain a running process or
commands that bypass the wrappers. Docker builder GC should have its own small
cache budget (for example `defaultKeepStorage: "2GB"`).

Maintenance keeps the newest two local deployment recovery points (one expanded,
one compressed, plus a compressed copy of the newest). On a separate private
backup host it retains the newest two plus the latest deployment on seven distinct
days and four distinct ISO weeks, at most thirteen copies. These are deployment
recovery points, not a continuous backup of changes made between deployments.
Each transfer is verified by SHA-256 and atomically accepted before local history
expires; every retained remote copy is checked again before remote pruning. A
transfer or verification failure preserves local history. Never use this policy
on mutable backup trees. It only selects completed releases with a successful
`after.json`; incomplete and linked backup directories stay untouched.

Install the same storage-policy helper on the backup host, owned by root and
executable by a dedicated unprivileged backup user. Give that user a private
store directory, no sudo access, and a scoped SSH key. Use a dedicated SSH config
with `BatchMode yes`, `IdentitiesOnly yes`, `ForwardAgent no`, and a verified host
key with `StrictHostKeyChecking yes`. The source host can write and expire its
own backups; this is not immutable ransomware protection. Capacity planning must
include retained archives and room for the next transfer. To restore, copy a
retained archive back, verify its SHA-256 against `receipt.json`, then use the
[archive restoration procedure](#archive-deployment-backups).

Maintenance also removes generated package/dependency artifacts from old,
unmodified, inactive deployment worktrees, retaining at least two recent builds
and the deployed source. Source code and agent worktrees remain intact. An
unreadable process prevents cleanup; on Linux hosts with restricted `/proc`, an
optional root-owned `process_inspector` helper runs only the read-only inspection
through `sudo -n`, while deletion stays under the ordinary user's identity. This
does not grant sudo access: omit that option if the deployment account does not
already have authority to run the helper. Packaging smoke fixtures explicitly
mark their temporary directories; only expired, idle, identity-matching marked
fixtures are cleaned after seven days. Arbitrary temporary files and user data
are never selected by age or filename alone.

After a successful deployment, run
[refresh-storage-tools.sh](../deployment/refresh-storage-tools.sh) from that
checkout to copy the operational helpers into an immutable commit directory,
then start `loop55-storage-maintenance.service` without blocking. Install the
[service](../deployment/loop55-storage-maintenance.service) and
[timer](../deployment/loop55-storage-maintenance.timer) under the deployment user's
`~/.config/systemd/user/`, reload systemd and enable the timer. The service shares
the deployment lock and skips overlapping work. Inspect its journal for failed
transfers or low-space guards; do not interpret skipped maintenance as a verified
backup. Keep the earlier compression-only service disabled when this policy owns
retention. Tests run with `node --test test/storage-policy.node.test.ts` alongside
the archive tests.
