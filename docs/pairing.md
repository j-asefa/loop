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

## Unified agents and Feed

The paired app shows agents and conversations from the laptop and connected Loop servers in one Feed and agent directory. Each agent and thread shows its execution environment. Opening a thread routes reads and actions to the server that owns it, so existing conversations continue with their original credentials and dispatch history. No provider sign-in is needed to read old chats. A fresh install works with only the laptop source and shows the same interface without an environment selector.

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
