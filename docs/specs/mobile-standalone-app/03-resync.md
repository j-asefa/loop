# Phase 3: reconnecting the app after a tunnel rotation, via `loop pair`

## Decision made: no automatic background discovery, and no new command

Quick Tunnel URLs rotate on every cold start and on every reconnect after a
drop (`src/tunnel.ts`, see `01-current-architecture.md`). An earlier version
of this spec considered an automatic rendezvous relay (a hosted pointer
service the CLI publishes signed origin records to, so an installed app could
rediscover the new origin with zero user action), and after that, a separate
`loop sync` command. **Both are out of scope.** `loop pair`
(`src/cli.ts:122-150`, action `"pair"`) already does exactly what's needed:
it mints a fresh single-use pairing secret for the **current** origin via
`Host.pair()` (`src/host.ts:218-223`) and renders it as a QR (`showPair()`,
`src/cli.ts:18-27`) — regardless of whether the origin just rotated or this
is the very first pairing ever. There is no behavioral difference between
"pairing a new device" and "reconnecting an already-installed one" from the
CLI's side; both are just "show me a fresh QR for wherever I'm reachable
right now." Adding a second command that does the same admin call with
different copy isn't worth the extra `--help` entry, doc section, and test —
reuse `loop pair` outright.

The standalone app scans that same QR **inside the app** (not by opening a
browser) and reloads itself pointed at the new origin — no relay, no signing
keys, no new hosted infrastructure, no new threat model beyond the pairing
flow that already exists. This is the right amount of automation for what's
actually a rare event (you restart your laptop, or the tunnel drops and
Cloudflare hands out a new subdomain on reconnect) — not something that needs
an always-on discovery channel. The user still doesn't touch Safari, doesn't
reinstall anything, and doesn't lose the home-screen icon; they run `loop
pair` and scan one code, in-app.

## The only change needed: `loop pair`'s copy

`showPair()`'s current text ("Pair this device") only makes sense for a
first-time pairing. Update it (or the surrounding message in
`src/cli.ts:122-150`) to read naturally for reconnection too — e.g. "Scan
with your phone to pair a new device, or with the Loop app to reconnect it
after a restart." No server-side change is required beyond what phase 5
already adds for bearer-token auth — `/pair`'s existing single-use-secret
mechanism handles this fine as-is, and no new admin action or CLI branch is
needed.

Since `Host.setOrigin()` (`src/host.ts:201-217`) already revokes every
device whenever the origin changes, an app reconnecting after rotation is
already unauthenticated at the new origin no matter what — so `loop pair`
producing a brand-new device record (new id, new bearer token, new CSRF
value) for what the user thinks of as "the same app" is completely fine and
requires no special-casing. Don't try to preserve device identity across a
reconnect; it's a normal fresh pairing under the hood, same as always.

## What the app does with the scan

This is the same code the standalone app needs for its *first-ever* pairing
(see `04-standalone-app.md`) — one in-app QR scanner, one handler, used both
times:

1. User opens the already-installed app, taps "Reconnect" (or the app
   auto-prompts this when it detects it can't reach the origin it last
   knew — see below), and scans the QR `loop pair` printed.
2. The QR encodes the same `${origin}/#pair=${token}` URL `Host.pair()`
   already produces (`src/host.ts:222`) — no new QR payload format needed.
   The app parses out `origin` and `token` itself instead of navigating a
   WebView to that URL.
3. The app POSTs `{ secret: token, name: "<device name>" }` to
   `${origin}/pair` directly (same request `src/client/Pairing.tsx` makes
   today), reads the bearer token phase 5 adds to that response body, and
   **replaces** whatever it had stored in secure storage (old origin, old
   token, old csrf all get overwritten — the old ones are dead anyway per
   the revocation behavior above).
4. The app reloads its WebView pointed at the new origin.

## Detecting "you need to reconnect" without a relay

The app doesn't get pushed a signal that the origin changed — it finds out
the boring way: requests to the origin it currently has stored start
failing (connection refused / DNS failure / timeout, which is exactly what
happens to a dead `*.trycloudflare.com` subdomain). When that happens
(WebView `onError`, or repeated failed pings from the shell — pick a
reasonable retry/backoff before giving up, don't flag "disconnected" on one
blip), show a clear in-app screen: "Can't reach your desktop. Run `loop
pair` and scan the new code," with the scanner one tap away. This is a
normal, expected state, not an error to bury in a toast.

## Definition of done for this phase

- `loop pair`'s printed message reads naturally for both first-time pairing
  and reconnecting an already-installed app; no new CLI command exists.
- The standalone app can go from "showing a dead-origin error" to "back to
  normal, talking to the new origin" via: open app → tap reconnect → scan →
  done. No browser, no reinstall, no new home-screen icon.
- No new hosted service, signing keys, or background polling exists anywhere
  in this phase.

---

Next: `04-standalone-app.md`.
