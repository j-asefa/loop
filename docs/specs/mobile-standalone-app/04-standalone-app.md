# Phase 4: a real standalone app, not an origin-locked PWA

## Decisions made

- **Shell technology: Expo/React Native.** One codebase, real App Store/Play
  Store installability, a WebView component, camera access for QR scanning,
  and secure storage all available without native Swift/Kotlin work.
- **Distribution: internal, not a public store listing.** Ship via Expo
  EAS Build to TestFlight internal testing (iOS) and a directly-installed/
  internal-track APK (Android) — no public App Store or Play Store
  submission. This is a personal companion app for a CLI tool the user runs
  themselves; public listing adds developer-account overhead, review
  latency, and real policy risk (app stores are inconsistent about
  WebView-wrapper apps whose primary content is a remote website) for no
  benefit here. Nothing about this choice blocks moving to a public listing
  later if that ever becomes worth it — it's the same build either way, just
  a different distribution channel — so don't build anything that assumes
  internal-only distribution is permanent.

Both checkpoints from the earlier draft of this file are resolved; proceed
directly to implementation.

## Why the PWA itself has to change, not just get a discovery mechanism

A **PWA installed via Add to Home Screen is identified by its origin** —
that's how iOS/Android decide which home-screen icon a given install
belongs to, what storage/cookies it can see, and what its service worker
scope is. There is no way to make a Safari-installed PWA transparently
follow a changing origin; the fix has to be an app whose identity is
independent of the URL it currently happens to be showing. Phase 3's reuse
of `loop pair` gives the *human* an easy way to reconnect it — this phase is
what makes the *app itself* able to survive that reconnect without losing
its installed identity.

## Recommended shape: thin native shell + WebView, reusing the existing UI

Don't rewrite the UI. `src/client/*` is a full React SPA already built for
this exact product; reimplementing it natively would be enormous and
pointless. Instead:

- Build a small native/cross-platform shell (Expo/React Native is the
  pragmatic choice — one codebase, real App Store/Play Store installability,
  a WebView component, camera access for QR scanning, and secure storage all
  available without native Swift/Kotlin work) whose **entire UI is a WebView
  pointed at a URL the shell computes at runtime**, not baked in at build
  time.
- The shell owns:
  1. **Persistent app identity** — one install, one icon, forever. Internal
     WebView URL changes are invisible to the OS.
  2. **Secure credential storage** — `expo-secure-store` (iOS Keychain /
     Android Keystore), not `localStorage` inside the WebView (which is
     origin-scoped and gets nuked exactly when the origin changes — the
     credential must outlive the origin).
  3. **In-app QR scanning** (`expo-camera` or equivalent), used for both
     first-ever pairing and for the reconnect flow described in
     `03-resync.md` — one scanner, one handler, in both cases scanning
     whatever `loop pair` printed: parse the scanned `${origin}/#pair=${token}`
     URL, POST it to `${origin}/pair` directly from the shell (not by
     navigating the WebView there), store the returned bearer token, then
     point the WebView at the new origin. This replaces "open Safari, hope
     you're looking at the right tab" entirely.
  4. **Failure detection**: when the WebView's requests to its current
     origin start failing (connection refused/DNS failure/timeout — exactly
     what a dead `*.trycloudflare.com` subdomain looks like), stop retrying
     silently after a reasonable backoff and show a clear "Can't reach your
     desktop — run `loop pair` and scan the new code" screen with the
     scanner one tap away. See `03-resync.md` for the full flow this feeds.
  5. **Injecting the portable device credential** into every request the
     WebView makes to the current origin (see `05-server-auth-changes.md` —
     cookies won't survive an origin change, so this has to be a header the
     shell attaches, not a cookie the browser attaches automatically).
     React Native WebView supports intercepting requests
     (`onShouldStartLoadWithRequest` doesn't cover XHR/fetch; the practical
     approach is injecting a small JS bridge via `injectedJavaScript` that
     wraps `window.fetch` and the WebSocket constructor to attach the stored
     credential, or run a tiny local loopback proxy inside the app process
     that the WebView talks to instead of the origin directly and which
     rewrites requests to add the header before forwarding to the real
     origin — pick whichever is more reliable against the RN WebView version
     you target and say which you chose and why).

## Repo layout

New top-level directory, e.g. `mobile/`, alongside the existing `src/`,
`public/`, etc. Keep it a clearly separate package (own `package.json`,
excluded from the root `tsconfig.json`/root test runs) so `npm test` /
`npm run check` at the repo root are unaffected by mobile tooling. Document
its own build/run steps in `mobile/README.md`.

## What must NOT regress

- The existing browser-based pairing flow (`src/client/Pairing.tsx`, scanning
  the terminal QR with any phone camera and opening it in Safari/Chrome)
  must keep working for anyone who hasn't installed the standalone app —
  don't make the web client assume it's running inside the native shell.
  Feature-detect the shell (e.g. a bridge object the shell injects,
  `window.LoopShell`) and only use the header-injection/native-storage path
  when it's present; fall back to the current cookie-based flow otherwise.
- `src/client/PairedDevices.tsx` and the device-revoke flow
  (`/api/workspace/revoke`, `src/host.ts:380-384`) keep working unchanged —
  a standalone-app device is still just a `Device` in `Host`'s device map
  (`src/host.ts:22-29`), it just authenticates with a bearer header instead
  of a cookie (see `05-server-auth-changes.md`). It should show up in the
  paired-devices list the same as a browser-paired one.
- `docs/companion/CLI.md`'s existing PWA install instructions stay accurate
  for users who prefer the lightweight browser path over installing the
  standalone app — don't delete that path, add to it.

---

Next: `05-server-auth-changes.md` for the concrete server-side changes this
phase and phase 3 both depend on.
