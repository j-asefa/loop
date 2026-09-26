# Phase 5: server-side changes phases 3 and 4 depend on

These changes are all in `src/host.ts` (the companion `Host` class) and
touch nothing in the server-profile auth (`src/server/auth.ts` — leave it
alone). Read `01-current-architecture.md`'s "Pairing and auth today are
origin-bound" section first; this phase is the fix for exactly the identity-
continuity problem described there (discovery itself is handled by reusing
`loop pair` in phase 3, which needs no server change beyond what's here).

## 1. Bearer-token auth path alongside cookies

Add a second way for a request to authenticate: an `Authorization: Bearer
<token>` header carrying the same kind of token that's currently only ever
set as a cookie value. Concretely, in `Host.authenticate()`
(`src/host.ts:261-274`):

- Today it only reads the cookie named `__Host-loop`/`loop_local`. Extend it
  to also check `req.headers.authorization` for a `Bearer ` prefix, and hash/
  compare that token the same way (`hash(token)` against `d.hash`,
  `src/host.ts:272`). A `Device` doesn't need a new field for this — it's the
  same token, just delivered a different way.
- The `/pair` handler (`src/host.ts:294-331`) currently always does
  `res.setHeader("Set-Cookie", ...)`. It should keep doing that (browser
  clients still need the cookie), but **the JSON response body should also
  include the raw token** so a native shell (which has no cookie jar
  concept it can rely on across origin changes) can capture it and store it
  itself via `expo-secure-store`. Returning a bearer token in a JSON
  response body that a script can read is normal for native-app auth (unlike
  a cookie, which is namespaced by the browser); make sure this response is
  only ever returned over the already-validated-origin, already-rate-limited
  `/pair` path (`src/host.ts:295-302`), not exposed anywhere else.
- CSRF: today's CSRF token (`device.csrf`, checked at `src/host.ts:362-366`
  for non-GET requests) exists to defend against cross-origin requests
  riding on an ambient cookie. A bearer-token client that explicitly attaches
  its own `Authorization` header on every request **is not vulnerable to the
  CSRF pattern the existing check defends against** (nothing ambient is
  happening) — but keep sending/checking `x-loop-csrf` for it anyway for
  consistency and because it costs nothing; just make sure the native shell
  captures and resends the `csrf` value from `/session`
  (`src/host.ts:333-343`) the same way the web client does
  (`src/client/api.ts`'s `authorize()`).
- WebSocket auth (`Host.listen()`'s `upgrade` handler,
  `src/host.ts:122-133`, via `this.authenticate(req)`) needs the bearer path
  too — browsers can't set arbitrary headers on a WebSocket upgrade, but a
  React Native WebView (or the shell's own bridge/proxy, per
  `04-standalone-app.md`) can, so make sure `authenticate()` being reused
  here (it already is — same function, same call site pattern) actually
  gets a request object with the header attached, whichever request path
  phase 4 chooses (JS-injected fetch/WS wrapper vs. local proxy).

## 2. `Host.validOrigin()` needs a non-browser path

`validOrigin()` (`src/host.ts:258-260`) checks the `Origin`/`Referer` header
to defend against cross-origin requests riding on an ambient cookie — a
browser-specific CSRF defense. It's called at `src/host.ts:295` (`/pair`) and
`src/host.ts:364` (write requests under `/api/`). A native shell issuing a
request with an explicit `Authorization: Bearer` header won't send a
matching `Origin` header the way a browser would, so `validOrigin()` as
written will reject legitimate bearer-authenticated write requests from the
shell. Trace both call sites and skip the `Origin`/`Referer` check
specifically for bearer-authenticated requests — CSRF requires an *ambient*
credential a browser attaches automatically, which a bearer token delivered
by an explicit header is not, so the defense simply doesn't apply to that
request path. Cookie-authenticated requests keep going through
`validOrigin()` exactly as today.

## 3. `Host.setOrigin()` keeps revoking everyone, unchanged

`setOrigin()` (`src/host.ts:201-217`) revokes every device on origin change.
**Leave this behavior exactly as it is.** With phase 3's design (reconnecting
via `loop pair` is a manual, on-demand re-pair rather than an automatic
silent reconnect), there's no need for any device — cookie or bearer — to
survive a rotation unrevoked: the human is already about to run `loop pair`
and get a fresh pairing secret regardless. Don't add any special-casing here
for bearer
tokens; a `Device` is a `Device` regardless of how it authenticates, and
`revoke()` (`src/host.ts:246-251`) doesn't need to know or care which
credential form a given device used.

## Tests to add

- `test/host.test.ts` (or wherever the existing `Host`-level tests for
  `/pair`, `/session`, and the WebSocket upgrade path live) — bearer-token
  auth for `/pair`'s response body, `GET /session`, an authenticated
  `/api/*` call, and the WebSocket upgrade path, all via `Authorization:
  Bearer` instead of cookies.
- A test confirming `setOrigin()` still revokes a bearer-authenticated
  device exactly like a cookie-authenticated one (no accidental exemption).
- A test that a bearer-authenticated write request succeeds without an
  `Origin` header, while a cookie-authenticated write request without a
  valid `Origin` header is still rejected as it is today.

---

Next: `06-plan-and-acceptance.md`.
