# Current architecture (read this first, verify against live code)

This is a map, not a spec. Line numbers are as of the commit this spec was
written against (`c908b96`, branch `claude/loop-cli-mobile-app-pkepcr`); the
code may have drifted — treat every reference below as "look here first,"
not gospel.

## Two deployment profiles, one codebase

`src/server/profile.ts`'s `companionMode` flag (driven by `LOOP_PROFILE`)
switches the same UI/DB/API between:

- **Server profile** (`loop server`, `src/cli.ts:69-85`): the original
  multi-user Loop server. Starts `src/server/serve.ts`'s `startServer()` and
  `src/server/worker.ts`'s `startWorker()` directly, foreground, no tunnel,
  no pairing — it's meant to sit behind your own HTTPS/Caddy setup
  (`compose.yaml`, `Caddyfile`, `docs/loop-v0/DEPLOYMENT.md`).
- **Companion profile** (`loop codex|claude|pi|opencode`,
  `src/cli.ts:86-345`): a single-user local host (`WorkspaceHost` in
  `src/workspace-host.ts`) wrapping the same `app` from `src/server/index.ts`,
  fronted by `Host` (`src/host.ts`), a from-scratch HTTP+WS server with its
  own pairing, device, and cookie-auth logic. This is a Cloudflare Quick
  Tunnel away from the phone.

The mobile-app problem below is entirely in the companion profile. Don't
touch the server profile's auth (`src/server/auth.ts`) for this work.

## Today's CLI command surface (`src/cli.ts`)

```
loop                              # see below — NOT "start the server" today
loop server                       # starts the server profile, foreground
loop codex|claude|pi|opencode     # starts/joins the companion host, foreground
loop pair | status | devices | devices revoke ID | doctor | stop | uninstall
```

Bare `loop` (no positional) at `src/cli.ts:156-169`: if a companion host is
already running (`control(dir, "status")` succeeds) *and* no flags were
given, it just re-shows the pairing QR for the running workspace. If no host
is running, `action` is `undefined`, harness auto-detection runs
(`src/cli.ts:174-201`), and if more than one harness is usable it interactively
prompts "Choose a harness" — it never starts anything by itself, and it never
starts the server profile. This is the piece phase 2 changes: bare `loop`
should always mean "launch the full Loop server," full stop.

`loop <harness>` when no host is running goes through
`src/cli.ts:266-344`: it constructs a `WorkspaceHost`, starts it, then starts
a Quick `Tunnel` (`src/tunnel.ts`) and blocks — `main()` doesn't return until
`SIGINT`/`SIGTERM`. The owning terminal must stay open (this is documented
behavior in `docs/companion/CLI.md` — "Keep the owning terminal open"). Phase
2 changes this to background itself and hand the terminal back immediately
after pairing is ready.

## Quick Tunnel lifecycle (`src/tunnel.ts`)

`Tunnel.start()` downloads a pinned, hash-verified `cloudflared` binary
(`helper()`, lines 33-99) and spawns
`cloudflared tunnel --url http://127.0.0.1:<port> --protocol http2`, scraping
stdout/stderr for the `https://*.trycloudflare.com` URL (`tunnelUrl()`,
lines 100-104). There is **no stable identifier anywhere in this URL** — it's
a fresh random subdomain assigned by Cloudflare's edge on every process
start, and again on every reconnect. `src/cli.ts:312-329`'s `connect()`
retries up to 3 times on tunnel exit, each retry getting a **new** URL, and
each time calling `host.setOrigin(origin)` again.

`Host.setOrigin()` (`src/host.ts:201-217`) is destructive by design: it
clears every pairing token and revokes every currently-paired device,
because cookies and the CSRF/device model are origin-scoped — see below. That
revocation is *correct* under the current cookie-based auth model and must
stay correct after phase 3/4 land; what changes is that revocation should no
longer mean "the human has to do something," because the app itself should
notice and reconnect.

## Pairing and auth today are origin-bound

- `Host.pair()` (`src/host.ts:218-223`) mints a single-use secret and returns
  `${this.origin}/#pair=${token}` — the URL embeds the *current* origin
  directly. `showPair()` in `src/cli.ts:18-27` renders that URL as a QR code
  in the terminal.
- The phone's browser opens that URL, `src/client/Pairing.tsx` POSTs the
  secret to `/pair`, and `Host`'s handler (`src/host.ts:294-331`) sets an
  **httpOnly cookie** (`__Host-loop` over HTTPS, `loop_local` over HTTP) via
  `Set-Cookie`. This cookie is scoped to the origin that issued it by every
  browser's cookie jar rules — a browser will simply never send it to a
  different `trycloudflare.com` subdomain.
  - `src/client/api.ts`'s `authorize()`/`authorizedFetch()` rely entirely on
    this ambient cookie plus a CSRF token fetched from `/session`
    (`src/host.ts:333-343`) — there's no bearer-token path in the client at
    all today.
- The "app" is `public/manifest.webmanifest` + the built SPA served from
  `Host`'s static-file branch (`src/host.ts:388-426`), installed by the user
  via Safari → Share → Add to Home Screen. **A PWA's installed identity
  (icon, storage, cookies, service worker scope) is the origin it was
  installed from.** A new `trycloudflare.com` subdomain is, as far as iOS is
  concerned, a completely different app with no relationship to the old
  icon. This is the root cause of "open the new link, save it again."

## Why this is hard, not just annoying

Two independent things break on every tunnel rotation:

1. **Discovery** — the phone has no way to learn the new origin except a
   human reading it off the terminal and doing something with it. There is
   no channel between "cloudflared picked a new subdomain" and "the phone
   already has an app open" other than the human.
2. **Reinstall** — today, that human has to redo the *install*, not just the
   pairing: open Safari, add a new home-screen icon, discard the old one,
   because a PWA's identity is its origin.

Phase 3 accepts that (1) needs a human in the loop — a single `loop pair` +
in-app QR scan, deliberately manual for security reasons (see
`03-resync.md`) — and focuses on making that the *only* thing the human has
to do. Phase 4/5 eliminate (2): moving device credentials out of cookies
into something the app itself holds and resubmits regardless of which origin
it's currently pointed at, and making "the app" a real installed app whose
identity doesn't depend on the origin its WebView happens to be loading, so
the same install and the same icon survive every resync.

## Harness model (unaffected, for reference)

`Harness = z.enum(["pi", "claude", "codex", "opencode"])`
(`src/protocol.ts:4`). `src/host-control.ts`'s `discover()` finds/validates
the executable and pinned version per harness; `src/adapters/*.ts` implement
each protocol. None of this needs to change for this feature — harness
selection, billing-mode prompts (`src/cli.ts:205-237`), and the native
session bridge (`src/server/native-sessions.ts`,
`src/server/native-tool-bridge.ts`) are all reused as-is by the new CLI
surface in phase 2.

## What ships as `loop` today

`package.json`'s `bin.loop` points at `dist/cli.js`
(`scripts/build-cli.mjs` produces it). `npm link`/`npm pack` are the only
install paths right now (`README.md`, `docs/companion/CLI.md`) — there is no
npm registry publish yet. Keep that true unless a later phase says otherwise;
don't add a publish step as a side effect of this work.

---

Next: `02-cli-command-redesign.md`.
