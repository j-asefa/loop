# Server operation

This guide covers operating the host that runs a Loop workspace: resource limits for agent workloads, backups and disk pressure. Loop ships only the companion workspace (`loop start`); see [pairing](pairing.md) to reach it from a phone, including the [Docker companion](pairing.md#docker-companion).

The paired companion negotiates compression for text and JSON
responses above 1 KiB. Event streams, downloads and byte ranges keep their original
representation. API responses remain `no-store`. Vite assets with content hashes
in their URLs are cached for a year as immutable; robot avatars revalidate with
ETags before reuse. HTML, service workers and manifests remain `no-store` so tabs
can discover updated builds. Preserve `Vary: Accept-Encoding` and these cache
headers through a reverse proxy; do not apply public caching to API responses.

## Keep agent workloads from exhausting the server

On a Linux host with systemd and cgroup v2, set `LOOP_NATIVE_LAUNCHER` to the
absolute path of [agent-scope.py](../deployment/agent-scope.py). Native Codex,
Claude, Pi, OpenCode and ACP-family harnesses enter a separate resource group
before execution. Their test workers, builds and other child processes inherit
the group, while the Loop API and execution coordinator stay outside it. The
launcher preserves protocol pipes (including metadata on descriptor 3), process
identity, working directory and native credentials. Placement failure refuses
the launch instead of running it without limits.

Native harnesses do not inherit Loop's server environment: data directories,
workspace home, service identity, encryption keys and server authentication
settings are removed before launch, including their `LOOP_*` aliases. Only
scoped adapter tool/billing settings and explicit test controls pass through;
provider credentials and native credential homes are preserved. Importing Loop
source from an agent's checkout therefore cannot select the live database from
an inherited setting. This prevents accidental configuration inheritance; it
does not restrict filesystem access by processes running as the same OS user.

For an 8 GiB, four-CPU host using the user service `loop.service`:

```sh
bash deployment/install-agent-resources.sh loop.service
# After active runs finish:
systemctl --user restart loop.service
```

The installer copies the launcher and installs
[loop-agents.slice](../deployment/loop-agents.slice): all native agent processes
together have a 5 GiB hard memory ceiling,
at most 1 GiB of swap and three CPUs. This leaves capacity for Loop and the OS;
it is an aggregate limit, not a fresh allowance for each agent. There is no
lower `MemoryHigh` threshold: early reclaim can otherwise stall all harnesses
even while the server's reserved capacity is free. A workload that
exhausts the ceiling can have its processes killed by the kernel; Loop must
report that failure and never automatically replay an uncertain action.

Adjust `~/.config/systemd/user/loop-agents.slice` for the host's capacity. Run the
installer after upgrades to refresh the helper; it preserves an existing slice
configuration and never restarts the service. Inspect `systemctl --user show
loop-agents.slice -p MemoryCurrent -p MemoryPeak -p MemoryMax` and the scope's
`memory.events` to diagnose pressure or a resource kill. This is resource
isolation, not a security boundary for an OS user with authority to change its
own units. Docker containers and external execution services need their own
resource limits because their processes are created by another service.

Loop observes out-of-memory kills in each native launch's dedicated resource
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

Periodic native display updates also defer on a busy database, retaining their
pending output for the next tick. They do not block the worker or retry native
commands. Completion and other authoritative writes retain their normal policy.

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

## Protect live data from build disk pressure

On a shared development host, builds, package fixtures and deployment copies can
fill the same filesystem used by SQLite. Reserve a separate filesystem for the
**whole `LOOP_HOME`**, including its workspace, configuration and helpers. A real
volume is preferable; a fully allocated ext4 image also reserves space on a
single-disk host. A sparse image does not reserve capacity. This separates space
budgets, not privileges: a process with access to Loop data or root can still
modify it, and the data filesystem itself needs free-space monitoring.

The Linux [reserved-volume helper](../deployment/reserved-volume.py) mounts an
already formatted image using a root-owned JSON configuration with `image`,
`mountpoint`, `bytes` and its filesystem `uuid`. It verifies the backing file is
private, fully allocated and has the expected UUID, refuses to hide an existing
data directory, and disables loop-device discard so inner filesystem trimming
cannot release the reserved blocks. It never formats or migrates data. Configure
a root oneshot systemd service with `RemainAfterExit=yes`, run its `mount` action
before the user manager starts, and use `verify` for checks. Add
`ExecStartPre=/usr/bin/mountpoint -q /absolute/LOOP_HOME` to Loop's service so a
failed mount cannot silently start a new workspace on the root disk. Copy data
only after all runs finish and Loop stops; verify contents and SQLite integrity
before restarting and removing the old copy.

### Storage budgets and bounded retention

[storage-policy.py](../deployment/storage-policy.py) supplies host-side guards
and retention, independently of the Loop process. It requires Linux, Python 3.9+,
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
then start `loop-storage-maintenance.service` without blocking. Install the
[service](../deployment/loop-storage-maintenance.service) and
[timer](../deployment/loop-storage-maintenance.timer) under the deployment user's
`~/.config/systemd/user/`, reload systemd and enable the timer. The service shares
the deployment lock and skips overlapping work. Inspect its journal for failed
transfers or low-space guards; do not interpret skipped maintenance as a verified
backup. Keep the earlier compression-only service disabled when this policy owns
retention. Tests run with `node --test test/storage-policy.node.test.ts` alongside
the archive tests.
