# Laptop launcher

Build with `npm ci && npm run build`, then run `node dist/cli.js` (or install/link the package and run `loop`). Node 24+, Git and OpenSSL are required; Docker Desktop / Engine is required only for Docker execution. The first HAPI build downloads the pinned source and Bun toolchain. Missing selected native harnesses are installed into Loop's private helper directory; existing host installations are retained.

First launch asks for OpenAI, Anthropic or both, and native, Docker or both. Noninteractive defaults are both providers and native execution; flags make the selection explicit:

```sh
loop --providers both --execution both --project /absolute/project
```

Preferences and projects persist under `LOOP_HOME` (default `~/.local/state/loop`). Subsequent `loop` invocations reuse them. `loop stop` is required before changing a running workspace's execution configuration. `loop codex`, `loop claude`, `loop pi` and `loop opencode` keep their companion-adapter behavior; `loop server` explicitly starts the server profile. The managed launcher uses the HAPI backend already present in PR #14.

The host launches one private HAPI Hub, its mTLS gateway, and the selected runners. Native children run as your user and retain your PATH, Docker context and project access. Each Docker runner has a separate persistent provider home and a bind mount of the chosen project at `/workspaces/project`; it receives no host Docker socket or host provider credentials. It uses the host user's numeric UID/GID so it can edit the selected checkout. The packaged image is built for the current Docker architecture.

Pair with the QR code. Under **Settings → Execution environments**, complete sign-in for any selected provider not already authenticated. Native sign-in uses the existing host home; Docker sign-in belongs to its volume. Verification creates a provider connection automatically. Create an agent by choosing its provider, **Run on**, model and project. Existing conversations retain their original provider connection and execution environment. Native and Docker agents may run concurrently.

Inference is remote. Native execution refers to the location of the CLI and its shell/file tools. Managed Codex enforces ChatGPT authentication without API fallback; managed Claude keeps PR #14's verified native authentication policy. Companion `loop claude` retains its separate existing-provider restrictions.

## Stable Cloudflare tunnel

Quick Tunnels start automatically. A Quick Tunnel can get a new address after restarting; the phone cannot discover that address without another `loop pair` scan. Device trust is preserved, but there is no new cloud discovery service.

For an existing locally managed named tunnel and DNS hostname:

```sh
loop --tunnel-name YOUR-TUNNEL-ID \
  --tunnel-config ~/.cloudflared/config.yml \
  --public-url https://loop.example.com
```

Loop saves these preferences, supervises cloudflared, and generates its own ingress configuration pointing only that hostname at the authenticated Loop gateway. The original configuration is unchanged; its credentials file is reused. Use a tunnel dedicated to Loop: other ingress services are deliberately excluded. Remote token-managed tunnels are not auto-enrolled by this command. `--public-url` alone continues to support an externally managed proxy.

Device hashes, CSRF secrets and expiration are restored from the private workspace store. Pairing links remain single-use and expire after two minutes. Device trust lasts one year of inactivity and renews on authenticated use. Explicit device revocation persists across restart. Host/origin/CSRF checks remain enforced. A stable named hostname therefore reconnects without re-pairing.

For automatic startup at login, after the initial setup:

```sh
loop service install
loop pair
```

This installs a per-user launchd agent on macOS or a systemd user service on Linux, using the current Node path, CLI path, PATH and project. It stops the detached workspace before handing ownership to the service. `loop service uninstall` stops/removes the service while retaining workspace data. Service mode restarts after failure; stop it with the service command rather than `loop stop` when you want it to stay stopped. Provider tools and Docker must be available in the saved user environment. No system-wide service or root permission is required.

## Storage and recovery

The merge upgrades both previous `main` databases and PR #14 databases, separating companion sessions from HAPI sessions and retaining histories. Server and companion authorization profiles remain separate; this does not migrate a Docker server workspace into the laptop companion.

Local artifact publication stores checksum-verified private files under the workspace data directory. Shared MemSearch stays available when configured, but is disabled by default for laptop startup without a memory service.

A failed runner is shown offline; dispatches with uncertain outcomes are reconciled rather than replayed. HAPI cold-resume controls remain explicit. Revoked environments are not silently re-enabled. Native process groups are owned by the launcher; managed HAPI sessions share that lifetime. Container recovery checks the exact identity label before replacing the previous container. Login and session volumes are retained on shutdown.

## Validation boundary

Automated tests cover the merged runtime contracts, companion decisions and cancellation, paired-device restart/revocation, native mTLS provisioning with protocol fixtures, independent provider/location selection, named-tunnel ingress, user-service rendering, and migration of both schemas. Protocol fixtures do not prove real provider availability.

Live acceptance still requires a laptop with Docker and authenticated provider accounts: run both providers in both locations; approve/cancel a tool from the phone; publish an artifact; resume a conversation; restart Loop and the named tunnel; verify that a native agent can run `docker ps`. macOS launchd and Docker Desktop must be tested on macOS. No authenticated inference or Cloudflare/Docker deployment is claimed by the automated suite.

The final automated run passed 210 server tests and 68 native tests. The server suite used a 15-second per-test timeout in this resource-constrained runtime.

In this development runtime, the patched HAPI executable was also cross-compiled for macOS ARM64 (not executed), built for Linux ARM64 and started with the real Codex CLI using an isolated, signed-out Codex home. The environment reached online, surfaced the expected sign-in requirement and shut down cleanly; no model request was made. The Loop tarball contains the launcher, managed worker, patch and Docker build inputs. Browser smoke execution was attempted but the container lacks Chromium's `libglib-2.0.so.0`; that check remains for CI/a laptop with browser dependencies.

## Review recovery and resource limits

Docker workers are limited to 4 GiB RAM, 2 CPUs and 256 processes in both the launcher and local Compose configuration. Launcher-created workers clone repositories beneath `/workspaces/project`, the persistent project bind mount. Existing clones outside that directory must be copied into the project mount before replacing an older container.

Paired-device credentials renew within a fixed two-year maximum lifetime. Existing credentials without a recorded maximum retain their current expiry as the maximum. Pair again after expiry; explicit revocation remains immediate. Coordinator credentials are withheld from provider subprocesses.

Messages submitted to an inactive native session remain unsent until explicit resume. A confirmed inactive rejection is retryable; a lost send acknowledgement remains uncertain and is never automatically replayed. Native permission decisions retain their answers and are retried during reconciliation until the provider reports completion.
