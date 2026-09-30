# Pairing and recovery

Pairing belongs to the laptop companion profile, including the managed launcher. The [server profile](server.md) uses local access, a gateway or accounts instead.

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

Use a dedicated tunnel. Loop generates ingress only for its authenticated gateway, reuses the credentials file and leaves the original configuration unchanged. Remote token-managed tunnels are not auto-enrolled. A stable hostname lets trusted devices reconnect without a new scan after normal restarts.

## Storage and recovery

`LOOP_HOME` defaults to `~/.local/state/loop`. Workspace state and its private encryption key live under `workspace/`. Stop Loop before backing up that complete directory; also preserve provider homes, project files and managed runtime volumes when applicable. Native history belongs to its harness. Server data directories are separate and cannot be reused as companion directories.

Background output is `workspace/daemon.log`, rotated at 5 MB to `daemon.log.1`. Pairing codes are not logged. Keep the computer awake; phone disconnection does not stop work.

If status reports a crash or unresponsive workspace, inspect logs and use `loop stop`. It checks recorded process identity before signaling, reports processes it cannot confirm and retains unresolved records for another stop attempt. Never assume an uncertain dispatch did not execute: inspect partial work before an explicit follow-up. `loop uninstall` retains workspace/native data and prints package-removal guidance.
