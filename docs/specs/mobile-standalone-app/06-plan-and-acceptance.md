# Phase 6: sequencing and acceptance

## Suggested sequencing across PRs

Land these as separate, independently reviewable PRs in this order — each
one should be shippable and non-regressive on its own, so don't hold phase 2
hostage to phase 3/4 decisions still being made:

1. **CLI command redesign + daemonization** (`02-cli-command-redesign.md`).
   Independently useful even if the app-reconnect work never happens —
   "loop backgrounds itself" is a real improvement on its own.
2. **Server auth: bearer tokens** (`05-server-auth-changes.md`). Land this
   before phase 4 needs it, additive and non-breaking — cookie auth keeps
   working exactly as before, this only adds a second accepted credential
   form.
3. **`loop pair` copy update for reconnection** (`03-resync.md`). Trivial —
   a message change, no new command or code path.
4. **Standalone app** (`04-standalone-app.md`). Can proceed in parallel with
   (3) — the app's scanner needs the bearer-token response shape from
   `05-server-auth-changes.md`, not anything else from phase 3, since both
   first-time pairing and reconnecting scan the exact same QR format.

## Acceptance checklist for the whole feature

Hold the finished work to this, end to end, on a real Quick Tunnel restart
(not just unit tests):

- [ ] `loop` with no arguments starts the server profile. `loop server` still
      works as an explicit alias.
- [ ] `loop codex` (substitute any harness) prints a pairing QR, then returns
      the shell prompt within a few seconds; the harness and tunnel keep
      running after the terminal is closed.
- [ ] `loop status`, `loop pair`, `loop devices`, `loop devices revoke`,
      `loop stop`, `loop doctor`, and the new `loop logs` all work correctly
      against the backgrounded process.
- [ ] Installing the standalone app once, pairing it, then **restarting**
      `loop codex` (forcing a brand-new Quick Tunnel origin) leaves the app
      showing a clear "can't reach your desktop" state (not a silent hang or
      a crash). Running `loop pair` again and scanning the code from inside
      the already-installed app reconnects it to the new origin. No
      reinstall, no new home-screen icon, no browser involved at any point.
- [ ] The existing browser-based pairing/PWA path
      (`src/client/Pairing.tsx`, `public/manifest.webmanifest`) still works
      unmodified for anyone who doesn't install the standalone app.
- [ ] Device revocation (`src/client/PairedDevices.tsx`, "Revoke device")
      works identically for a browser-paired device and a standalone-app-
      paired device, and both show up in the same list.
- [ ] No change to billing behavior: subscription-mode harnesses never fall
      back to API billing as a side effect of any of this work.
- [ ] `docs/companion/CLI.md`, `README.md`, `docs/UNIFIED-LOOP.md`, and
      `src/cli.ts --help` are all updated to describe the new command
      surface and pairing flow accurately — no stale instructions describing
      the old bare-`loop`/foreground-blocking/re-add-to-home-screen behavior.
- [ ] `npm run check`, `npm test`, `npm run test:native` all pass. If a
      `mobile/` package was added, its own checks (whatever `mobile/README.md`
      documents) pass too, and it's excluded from the root test/typecheck
      runs.

## Open questions to flag back to the user if they come up mid-implementation

Both checkpoints this spec originally called out are resolved (no relay and
no new command — reuse `loop pair`; Expo/React Native shell, internal
distribution). If you
find yourself needing to guess something similarly consequential that isn't
covered by this spec (e.g. an actual Apple/Google developer account to build
under, or a materially different scope cut than what's described here), stop
and ask rather than picking a default silently. Everything else — file
layout, exact error message text, log rotation details, which QR library the
mobile shell uses — is yours to decide using good judgment; don't escalate
implementation details that don't change the product's behavior or its trust
model.
