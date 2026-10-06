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

A Quick Tunnel address can change after restart or reconnection. For a browser installation, run `loop pair`, scan the new code with your phone's camera, and add the new page to your home screen. Browser storage and home-screen icons are tied to the old origin. A new scan creates a fresh device entry; revoke unused entries.

`--local-only` creates loopback URLs for desktop testing; these cannot be reached from a phone. For your own proxy use `--public-url https://loop.example.com` and forward to the printed loopback port. Never expose private administration or native tool endpoints.

The managed launcher can supervise an existing locally managed named Cloudflare tunnel:

```sh
loop start --tunnel-name YOUR-TUNNEL-ID --tunnel-config ~/.cloudflared/config.yml --public-url https://loop.example.com
```

Use a dedicated tunnel. Loop generates ingress only for its authenticated gateway, reuses the credentials file and leaves the original configuration unchanged. Remote token-managed tunnels are not auto-enrolled.

## Storage and recovery

`LOOP_HOME` defaults to `~/.local/state/loop`. Workspace state and its private encryption key live under `workspace/`. Stop Loop before backing up that complete directory; also preserve provider homes, project files and managed runtime volumes when applicable. Native history belongs to its harness. Server data directories are separate and cannot be reused as companion directories.

Background output is `workspace/daemon.log`, rotated at 5 MB to `daemon.log.1`. Pairing codes are not logged. Keep the computer awake; phone disconnection does not stop work.

If status reports a crash or unresponsive workspace, inspect logs and use `loop stop`. It checks recorded process identity before signaling, reports processes it cannot confirm and retains unresolved records for another stop attempt. Never assume an uncertain dispatch did not execute: inspect partial work before an explicit follow-up. `loop uninstall` retains workspace/native data and prints package-removal guidance.

## Unified agents and Feed

The paired app shows agents and conversations from the laptop and connected Loop servers in one Feed and agent directory. Each agent and thread shows its execution environment. Opening a thread routes reads and actions to the server that owns it, so existing conversations continue with their original credentials and dispatch history. No provider sign-in is needed to read old chats. A fresh install works with only the laptop source and shows the same interface without an environment selector.

**New agent → Run on** lists connected provider destinations across sources. Pick the laptop, a managed Docker runner or a connected older Docker server for that agent. The new agent and its conversations live on the selected source. Project choices are scoped to that source. Files uploaded to one source cannot be attached when creating an agent on another source. An online runner that needs a provider connection links to its sign-in setup; that connection must be verified before new work starts.

The companion currently discovers multiple running local Docker Compose Loop servers whose service is `app` or `loop`, whose port 3000 is published on `127.0.0.1`, and whose authentication mode is single-user. Each appears as an agent source while it is running. Discovery does not import or duplicate its database: each server keeps its owner, provider credentials, worker and conversation dispatches. Paired requests pass through the laptop's authenticated gateway; the device cookie and CSRF token are not sent to Docker. Stopped or unpublished servers disappear from the Feed until available again. A server's source ID comes from its Compose project and service, so thread links survive `docker compose up` recreating the container; links made with the earlier container ID, and older `?workspace=docker:…` links, still open their threads while that container runs.

Multiple HAPI execution environments, including runners on other machines, can already hold agents in one Loop workspace; their agents appear in the same Feed and have their own **Run on** destinations. Linking an independent Loop server on a cloud host or another laptop requires a source adapter and secure enrollment for that host. The client Feed and source routing use opaque source IDs so those adapters do not require another workspace selector. See [architecture](architecture.md#agent-sources-and-execution-environments).

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

Scan the terminal QR and tap **Pair and open Loop**. Pairing codes are printed only in the interactive terminal, never in container logs. The pinned tunnel helper is baked into the image and verified against the same release hash used by the laptop launcher.

The separate named volumes preserve workspace/device state, provider homes and managed helpers under `/data/loop`, and projects under `/workspaces`. Native execution runs inside this container; nested Docker execution is rejected. No ports or Docker socket are published. Both desktop and phone use the Quick Tunnel URL. Restarting can change that URL: run `loop pair` again and follow the reconnect instructions above. Device records survive; browser cookies remain bound to their origin.

```sh
docker compose -f compose.companion.yaml exec loop-companion loop status --json
docker compose -f compose.companion.yaml exec loop-companion loop devices
docker compose -f compose.companion.yaml exec loop-companion loop devices revoke DEVICE_ID
docker compose -f compose.companion.yaml logs -f loop-companion
docker compose -f compose.companion.yaml stop
```

Use Compose logs for foreground service output. `loop logs` remains available for any CLI daemon log in the persistent workspace. Stop through Compose to avoid its restart policy restarting an intentionally stopped CLI. Preserve both volumes when upgrading; do not use `down --volumes` for real workspaces. The server's `compose.yaml` and its data volume remain separate.

The companion prepares Codex, Claude Code, guarded OpenCode and Pi using native execution inside the container. Sign in through the app on that runner. Codex, Claude Code and managed OpenCode require subscription authentication; Pi uses its existing billing configuration. Preparation failures retain the direct fallback and report the setup failure.
