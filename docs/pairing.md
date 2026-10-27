# Pairing and recovery

Pairing belongs to the companion profile, running on a laptop or in Docker. The [server profile](server.md) uses local access, a gateway or accounts instead.

## Pair a device

Start a workspace with `loop start` or `loop <harness>`, then scan the displayed code with your phone's camera. The link opens Loop in your mobile browser; confirm **Pair and open Loop**, then use **Share → Add to Home Screen**. Run `loop pair` for a fresh code. Links are single-use and expire after two minutes; anyone holding one can gain control of the workspace.

The browser installation uses an HttpOnly session cookie. Pairing issues cookies only; bearer device credentials are no longer issued or accepted. Cookie requests use Host/Origin and CSRF checks. Revoke the device on the computer if the phone is lost.

```sh
loop status --json
loop devices
loop devices revoke DEVICE_ID
loop logs --follow
loop stop
```

Device trust survives restart and address changes. It renews on use for up to one year of inactivity, subject to a fixed two-year maximum lifetime. Older records without a maximum retain their existing expiry as that maximum. Revocation persists. Expired or revoked devices must pair again. The implementation is [src/host.ts](../src/host.ts).

Companion workspaces store device trust in their workspace database through
[FleetPairing](../src/server/fleet-pairing.ts). On first
startup, they import the existing `devices.json` once and replace it with a
migration marker before opening the gateway. Restore the complete workspace
directory, including the database, `devices.json` and `device-expiry-checks/`,
together. Older binaries refuse this marker instead of using a stale
device list that could undo a revocation. Isolated previews keep separate device
state.

The gateway checks device expiry on access, at startup and on its heartbeat.
Before reading the clock, it writes a durable check containing only the owner
and device IDs. A successful check removes that record after any expired device
has been deleted from the database. If storage fails or the process exits during
the check, recovery retires the named devices before opening the gateway, even
if the clock has moved backwards. This can require a device to pair again after
an interrupted check; completed checks preserve ordinary restart sessions.
Unreadable checks, a clock rollback or failure to record a new check refuse
device access until the clock/storage issue is repaired and Loop restarts.
Local `loop devices` listing and revocation remain available independently of
authentication eligibility. Valid devices can still authenticate during database
writer contention; optional session renewal defers on contention.

Companion gateways expose a dedicated [fleet enrollment protocol](fleet-openapi.json)
at fixed `/api/fleet/peer/v1/enrollment/` endpoints. It accepts machine proofs
and the one-time enrollment capability, never a browser cookie, Cards token or
local-administration credential. The destination binds consent to its own local
owner. A signed receipt query resolves a lost response without repeating the
effect; enrollment never creates a device cookie for a peer. Previews and
server-profile applications do not expose this companion protocol.

Peer clients contact bare public HTTPS origins through connection-time DNS
validation. They verify the confirmed machine identity before transmitting the
enrollment capability and refuse redirects. Requests and responses are bounded
to 4 MiB; enrollment transport has a 15-second deadline and does not retry
uncertain effects. The companion admits at most 16 incomplete enrollment
requests at a time, separately from its browser routes. The interactive fleet
administration and directory synchronization workflow is not yet exposed.

HTTPS pairing links carry independent device and fleet-enrollment capabilities.
The local pairing page retains and submits only the device capability, removes
the fragment from browser history, and consumes both capabilities in the same
transaction that creates the device record. A failed validation or full device
list does not consume the code. Local HTTP links retain the legacy device-only
format. Unused codes expire using both local wall and monotonic time and become
invalid on application restart; run `loop pair` for a fresh code. Completed
enrollment receipts and existing device trust survive restart. Enrollment
transport is not yet exposed by this pairing foundation.

Existing Expo app installations must migrate to the browser: run `loop pair`, open the new link in your phone’s browser, and add Loop to the home screen again. The native app’s session hand-off is no longer supported.

## Tunnels and reconnect

By default Loop starts a pinned, hash-verified cloudflared Quick Tunnel. Cloudflare terminates TLS. Native transports and private administration stay local; public workspace updates use authenticated WebSockets with polling recovery.

### Connection service: one address across restarts

The tunnel runs in a separate per-workspace **connection service**, not in the Loop application. The service owns cloudflared, a stable loopback relay and a private control socket; the application registers behind it each time it starts. Restarting or upgrading the application therefore keeps the same cloudflared process, the same Quick Tunnel address and the same paired browser session: bookmarks and home-screen installs keep working without pairing again.

```sh
loop restart            # application only; the address stays
loop restart --force    # also when runs are active or the application hangs
loop upgrade            # install remote main while Loop runs, then restart into it
loop stop               # everything, including the tunnel
```

- `loop start` reuses a running, compatible connection service or starts exactly one. If the application is down but the service runs, `loop start` or `loop restart` brings it back at the same address. If the service exited while the application runs, `loop start` starts a new one (a new Quick Tunnel address), waits for the running application to adopt it, then shows a code for that address.
- `loop restart` repeats the application's saved launch (harness, project, providers, native/Docker execution, billing and tunnel settings) using the installed build. The launch is saved with absolute project, executable and tunnel config paths, so a restart from any directory, including of a `--foreground` launch, serves the same workspace. It refuses while runs are active; `--force` follows the normal shutdown recovery, which marks interrupted work for review and never resends it.
- `loop upgrade [--from PACKAGE]` installs first; a failed install leaves the running application untouched. It then runs the newly installed CLI's restart, so the new build is what serves.
- `loop stop` stops the application, its runners, the connection service and cloudflared, including what a crash left behind. The next start gets a new Quick Tunnel address.
- `loop status --json` reports the application and, under `connection.service`, the service, tunnel and registered application generation separately, without credentials. When only the application is down it still reports the unchanged `url`.
- `loop pair` asks the running application for a one-time code. It never creates a tunnel or changes existing device trust.

While the application restarts, the relay answers `503` with `Retry-After` and `X-Loop-Unavailable: restarting`. Requests are never queued or replayed across application launches; a mutation interrupted after it reached the application is reported as `502` with an unknown outcome, and Loop's durable request keys reconcile any later explicit retry. Open pages keep their thread, drafts and scroll, show “Loop is reconnecting…”, and resubscribe with their event cursor. A page opened during the restart receives a generic reconnect page that retries itself. When the restart brings new browser assets, the page offers **Reload to update** rather than reloading on its own.

The address is preserved only while the connection service and its Quick Tunnel live. `loop stop`, a reboot, replacing the connection service or an actual cloudflared failure that reconnects with a new hostname can change it; then run `loop pair` and scan the code from the Loop app. A Quick Tunnel hostname cannot be reserved, and Cloudflare documents no uptime guarantee for Quick Tunnels. Browser storage and home-screen icons belong to an origin, so a changed address needs a new home-screen install; device records survive, and a new scan creates a fresh entry you can revoke.

**First upgrade from an earlier release.** Earlier releases ran cloudflared inside the application. Moving it into the connection service changes the address once: `loop restart` (or `loop upgrade` run by this release) prints a fresh code. Releases before this one implemented `loop upgrade` by restarting Pi; to keep your runtimes on that first transition, install the new release (`npm install -g https://github.com/j-asefa/loop.git#main`, or `git pull && bash install` in a checkout) and run `loop restart` instead. Later restarts keep the address.

**Security boundary.** The connection service never sees provider credentials and is not a workspace API. Its relay listens only on `127.0.0.1` and forwards the original Host, Origin, cookies and CSRF header, so the application keeps enforcing device authentication. A new launch receives a generation-bound lease, listens on a private Unix socket in a `0700` directory, and must answer an HMAC challenge keyed by that lease before the service forwards anything to it; an unrelated listener or a superseded launch never receives browser traffic. A launch that stops answering or sending heartbeats is withdrawn within seconds. The service keeps its records in `connection/` under `LOOP_HOME` (`connection.json` holds the control token, mode `0600`); socket paths too long for Unix sockets move to `/tmp/loop-UID/`.

**Records and recovery.** `connection.json` is versioned (`schema`, `protocol`). A CLI that finds a service it cannot confirm, or one speaking another protocol, reports it and does not replace it silently; `loop stop` replaces it, changing the Quick Tunnel address. A stale record whose process has exited is cleaned up by the next `loop start` or `loop stop`, which also stops the recorded cloudflared only after confirming its process identity. Service output goes to `connection/daemon.log`.

`--local-only` creates loopback URLs for desktop testing; these cannot be reached from a phone and never start the connection service or cloudflared. For your own proxy use `--public-url https://loop.example.com` and forward to the printed loopback port; Loop does not start or manage that proxy, and the printed port changes when the application restarts. Never expose private administration or native tool endpoints.

The managed launcher can supervise an existing locally managed named Cloudflare tunnel:

```sh
loop start --tunnel-name YOUR-TUNNEL-ID --tunnel-config ~/.cloudflared/config.yml --public-url https://loop.example.com
```

Use a dedicated tunnel. Loop generates ingress only for its authenticated gateway, reuses the credentials file and leaves the original configuration unchanged. Remote token-managed tunnels are not auto-enrolled. A named tunnel also runs in the connection service, so application restarts keep its connection up; its hostname never changes.

## Storage and recovery

`LOOP_HOME` defaults to `~/.local/state/loop`. Workspace state and its private encryption key live under `workspace/`. Stop Loop before backing up that complete directory; also preserve provider homes, project files and managed runtime volumes when applicable. Native history belongs to its harness. Server data directories are separate and cannot be reused as companion directories.

Background output is `workspace/daemon.log`, rotated at 5 MB to `daemon.log.1`; the connection service writes `connection/daemon.log`. Pairing codes are not logged. Keep the computer awake; phone disconnection does not stop work.

If status reports a crash or unresponsive workspace, inspect logs and use `loop restart --force` to replace only the application, or `loop stop` to stop everything. It checks recorded process identity before signaling, reports processes it cannot confirm and retains unresolved records for another stop attempt. Never assume an uncertain dispatch did not execute: inspect partial work before an explicit follow-up. `loop uninstall` retains workspace/native data and prints package-removal guidance.

The companion runs its HTTP gateway and native execution worker in separate processes. A worker crash keeps the gateway and pairing available while the host attempts replacement; interrupted work is not resent. `loop stop` stops both processes and their recorded native children, while ordinary `loop restart` still refuses active runs and preserves the connection service address. If execution ownership or child processes cannot be confirmed, recovery stops with the records under `workspace/execution/` retained for inspection. Do not delete `ownership.sqlite` to force takeover. A retained owner from a stopped container has a [generation-bound recovery command](#recovering-retained-execution-ownership). See the [execution authority](architecture.md#companion-execution-authority) for the ownership contract.

Authenticated `/api/build` includes API event-loop delay statistics in milliseconds. The API also emits an `api-event-loop` diagnostic every 30 seconds to the existing logs, with its sample count, window length, mean, p95, p99 and maximum. Compare these with client request times when investigating a slow streaming conversation; they measure event-loop scheduling delay, not provider response time. Native control ownership is described in the [execution authority](architecture.md#companion-execution-authority).

## Unified agents and Feed

The paired app shows agents and conversations from the laptop and connected Loop servers in one Feed and agent directory. Each agent and thread shows its execution environment. Opening a thread routes reads and actions to the server that owns it, so existing conversations continue with their original credentials and dispatch history. No provider sign-in is needed to read old chats. A fresh install works with only the laptop source and shows the same interface without an environment selector.

Local agents, Feed badges and **Run on** choices display the computer's name: the friendly **Computer Name** from macOS System Settings, or the OS hostname on Linux. Loop reads it on the execution computer and sends it through the authenticated workspace API. Restart Loop after renaming the computer. If the name cannot be read, Loop shows **This computer**.

Connected Docker workspaces display **Docker · project/service**, so `research/app` and `research/loop` remain distinguishable within the same Compose project. A standalone Docker companion displays **Docker · name** using `LOOP_ENVIRONMENT_NAME`, or its container hostname when unset. The supplied companion Compose file defaults that name to `COMPOSE_PROJECT_NAME/loop-companion`, keeping it stable when the container is replaced. To choose a custom label or apply a changed value, run `LOOP_ENVIRONMENT_NAME=research docker compose -f compose.companion.yaml up -d --no-deps loop-companion`. This variable only changes display text; source and conversation IDs are unchanged. A container whose name cannot be read falls back to **Docker**.

**New agent → Run on** lists connected provider destinations across sources. Pick the laptop, a managed Docker runner or a connected older Docker server for that agent. The new agent and its conversations live on the selected source. Project choices are scoped to that source. Files uploaded to one source cannot be attached when creating an agent on another source. An online runner that needs a provider connection links to its sign-in setup; that connection must be verified before new work starts.

The companion currently discovers multiple running local Docker Compose Loop servers whose service is `app` or `loop`, whose port 3000 is published on `127.0.0.1`, and whose authentication mode is single-user. Each appears as an agent source while it is running. Discovery does not import or duplicate its database: each server keeps its owner, provider credentials, worker and conversation dispatches. Paired requests pass through the laptop's authenticated gateway; the device cookie and CSRF token are not sent to Docker. Stopped or unpublished servers disappear from the Feed until available again. A server's source ID comes from its Compose project and service, so thread links survive `docker compose up` recreating the container; links made with the earlier container ID, and older `?workspace=docker:…` links, still open their threads while that container runs.

Local native harnesses and configured remote subscription hosts can hold agents in one Loop workspace. Linking an independent Loop server on a cloud host or another laptop requires a source adapter and secure enrollment for that host. The client Feed and source routing use opaque source IDs so those adapters do not require another workspace selector. See [architecture](architecture.md#agent-sources-and-execution-environments).

The Feed's **Social** tab uses the paired laptop's subscriptions and stories. Older Docker servers may not have Social endpoints.

Browser and PWA installations on different origins still have separate device cookies. Pair and install a standalone Docker companion separately if you use its own URL. Revoke unused device records on their workspace host.

## Docker companion

With Docker and git installed, use the dedicated Compose file. It requires no host Node installation or `.env` and starts only the companion:

```sh
git clone https://github.com/J-Asefa/loop.git
cd loop
docker compose -f compose.companion.yaml up --build -d
docker compose -f compose.companion.yaml exec loop-companion loop pair
```

Scan the terminal QR and tap **Pair and open Loop**. Pairing codes are printed only in the interactive terminal, never in container logs. The pinned tunnel helper is baked into the connection image and verified against the same release hash used by the laptop launcher.

The stack has two containers. `loop-connection` runs only the [connection service](#connection-service-one-address-across-restarts): cloudflared and the relay, with a private `loop-companion-connection` volume and no provider homes, projects or Docker socket. `loop-companion` is the application; it registers with the service through a Unix socket on that shared volume. The named volumes preserve workspace/device state, provider homes and managed helpers under `/data/loop`, and projects under `/workspaces`. Native execution runs inside the application container; nested Docker execution is rejected. No ports or Docker socket are published. Both desktop and phone use the Quick Tunnel URL.

Restarting, rebuilding or replacing only the application container keeps the address, the cloudflared process and paired browsers:

```sh
docker compose -f compose.companion.yaml restart loop-companion
# Update the application alone after git pull; --no-deps leaves the connection running.
docker compose -f compose.companion.yaml up -d --build --no-deps loop-companion
```

Without `--no-deps`, a rebuild that changes the connection image recreates `loop-connection` too and the address changes. Inside the containers, `loop restart` is refused: restart the container instead. `docker compose down` (or recreating `loop-connection`) stops the tunnel; the next start gets a new address, so run `loop pair` again and follow the reconnect instructions above. The first `up` after upgrading from the single-container file adds `loop-connection` and changes the address once; existing volumes are reused.

```sh
docker compose -f compose.companion.yaml exec loop-companion loop status --json
docker compose -f compose.companion.yaml exec loop-companion loop devices
docker compose -f compose.companion.yaml exec loop-companion loop devices revoke DEVICE_ID
docker compose -f compose.companion.yaml logs -f loop-companion loop-connection
docker compose -f compose.companion.yaml stop
```

Use Compose logs for foreground service output. `loop logs` remains available for any CLI daemon log in the persistent workspace. Stop through Compose to avoid its restart policy restarting an intentionally stopped CLI. Preserve the volumes when upgrading; do not use `down --volumes` for real workspaces. The server's `compose.yaml` and its data volume remain separate.

The companion prepares Codex, Claude Code, OpenCode and Pi using native execution inside the container. Sign in through the app on that runner. Codex and Claude Code require subscription authentication by default; Pi and OpenCode use their existing billing configuration, which may incur API charges. Each harness is checked independently.

## Recovering retained execution ownership

After an unclean host reboot, a container restart, or moving workspace data, startup can report that the retained execution owner belongs to another PID namespace lifetime. Linux identity includes the host boot and namespace init process, so reusing the same namespace inode does not make old PIDs safe to signal. macOS uses its kernel boot-session UUID to distinguish a reboot or another Mac; an unavailable boot identity blocks startup. Acquiring the worker lock proves that its holder is gone, but does not prove that native children outside this host or container have stopped.

On a companion cold start, this refusal happens before the HTTP gateway listens, so the companion cannot serve Settings or its workspace status response. Use the CLI procedure below to inspect the retained generation and recover after confirming that the previous host and all its processes stopped.

For a local installation after a confirmed reboot, first confirm that the previous host and all its processes stopped. If the workspace was moved or shared, also confirm the original host stopped using it. Inspect the retained generation, then substitute it in the recovery command:

```sh
loop recover-execution
loop recover-execution --stopped-generation UUID_FROM_OUTPUT
loop start
```

This is an explicit operator assertion, required after an unclean reboot; automatic startup remains blocked until it is made. The same procedure applies to retained records that predate host identity tracking, after confirming their prior host and all its processes stopped. A completed `loop stop` retires its verified execution owner under the lock, so a later reboot or container replacement needs no manual ownership recovery.

For a container installation, use the following procedure.

Stop the application through Compose and confirm it is exited. Also stop any other container using the same workspace volume. Keep the connection service running if you want to preserve its address. Then inspect the retained generation with a temporary container:

```sh
docker compose -f compose.companion.yaml stop loop-companion
docker compose -f compose.companion.yaml ps -a loop-companion
docker compose -f compose.companion.yaml run --rm --no-deps loop-companion loop recover-execution
```

Only after confirming the old container and all processes in its namespace have stopped, substitute the printed generation below. This argument is an explicit operator assertion; the command cannot verify a foreign namespace itself.

```sh
docker compose -f compose.companion.yaml run --rm --no-deps loop-companion loop recover-execution --stopped-generation UUID_FROM_OUTPUT
docker compose -f compose.companion.yaml up -d --no-deps loop-companion
```

Recovery takes the existing exclusive lock, refuses an active holder or a changed generation, and archives only that previous namespace lifetime's owner and child records under `workspace/execution/retired-*`. It keeps the lock inode, database, credentials, devices and history. The next worker performs normal interrupted-run recovery; no external action is replayed. For records with the current host/namespace lifetime identity, use `loop stop` and resolve any reported live or unidentified processes instead. An unreadable process registry is retained and blocks stop and takeover until its uncertainty is resolved.
