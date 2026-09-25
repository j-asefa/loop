# Run and install Loop

## Local setup

Requirements: Node.js 24 and npm, a persistent local disk, and a modern browser. No provider credential is needed to boot or import history.

```sh
npm ci
npm run setup
npm run build
node --env-file=.env scripts/serve.mjs
```

Open http://localhost:3000 directly into your personal workspace. No Loop account or password is needed. `serve` starts the API and independent worker. The Node server binds to loopback by default. For development use separate terminals: `npm run dev`, `npm run worker`, and optionally `npm run ui` (Vite at port 5173; set LOOP_URL accordingly for origin checks). Workspace and maintained-auth database migrations run on startup. `npm test` runs deterministic tests; `npm run smoke:browser` requires Playwright Chromium (`npx playwright install chromium`) or an explicit `CHROMIUM_PATH`. Set `LOOP_BROWSER=webkit` for WebKit.

Connect your OpenAI or Anthropic API account in Settings. The model list comes from that connection. Provider API keys and MCP secrets are encrypted using LOOP_ENCRYPTION_KEY; never change that key without a migration. Chat exports are a separate Import conversations flow. For subscription usage, run the Docker runtime services and follow SUBSCRIPTIONS.md. API connections remain optional.

## Docker Compose: no domain required

Run `node scripts/setup.mjs` (also upgrades an existing `.env` with a runtime token), then `docker compose up --build -d`. The default stack starts Loop's API/worker, builds the official runtime image, and starts the private Docker runtime broker. Open **http://localhost:3000**. The published port binds to 127.0.0.1. Compose explicitly enables `LOOP_LOOPBACK_PROXY=1` for requests arriving through Docker's private host bridge; this setting requires a loopback-only published port. For LAN access with Loop account sign-in, set `LOOP_AUTH_MODE=multi-user`, `LOOP_BIND_ADDRESS=0.0.0.0` and `LOOP_URL=http://YOUR-SERVER-IP:3000`; HTTPS is preferred for remote use and PWA features.

Connect subscriptions in Settings using [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md). Docker credentials are not provider API credentials. The default installation includes native per-account containers and needs no API key. Docker access belongs only to the private broker, not to the web app or model container. The host must support Docker's Linux containers and persistent volumes.

`GET /api/health` reports API/worker readiness. `docker compose logs -f loop runtime-broker` shows service logs. CI's separate containers job builds the production images, opens the default personal workspace without registration or cookies and checks unsigned native status through the broker; see the PR for the current result. No authenticated inference is claimed by this smoke check.

## Workspace access

`LOOP_AUTH_MODE=single-user` is the default. A fresh install creates a persistent workspace identity without a user account. An existing installation with one account reuses its owner ID, so history, agents, tools and encrypted connections remain available. Migration 15 stores that identity. If multiple accounts already exist, set `LOOP_SINGLE_USER_EMAIL` to explicitly select one, or use multi-user mode. Changing modes never merges or transfers other accounts' data. A fresh personal workspace stays available when returning to single-user mode; accounts created in multi-user mode have their own workspaces.

Local access accepts loopback addresses and checks the request's actual Host and Origin. Client-supplied forwarding headers cannot grant access. Loop's account registration, password and sign-out routes are disabled in single-user mode, and account controls are omitted from the UI.

For remote single-user access, put an authenticated HTTPS gateway in front of the private app port. Set `LOOP_URL` to its public origin and generate a private token of at least 32 characters for `LOOP_GATEWAY_TOKEN`. The gateway must authenticate the visitor, then **overwrite** `X-Loop-Gateway-Token` with this token when proxying to Loop. Never expose the token to browser code or accept a visitor-provided value. Loop checks this token before returning workspace data; missing/wrong tokens and other origins are rejected. The user signs in once at the gateway and then enters the workspace directly. Direct local access remains available without that sign-in. An external URL without a gateway token stops single-user startup with a configuration error.

`LOOP_AUTH_MODE=multi-user` restores Loop's email/password sign-in, optional GitHub sign-in and separate owner-scoped workspaces. Use this when Loop itself provides the remote login, including the simple Caddy deployment below. Keep `BETTER_AUTH_SECRET` and `LOOP_ENCRYPTION_KEY` stable in either mode.

## Optional HTTPS for remote/iPhone use

A hosting-provider HTTPS URL or a tunnel works; a custom domain is not required. Use either the authenticated single-user gateway above or multi-user mode with Loop's own login. Set `LOOP_URL` to the actual public HTTPS origin and restart Loop so access and origin checks use it. Keep the direct app port private. Set `LOOP_BEHIND_PROXY=1` when your trusted proxy replaces the client-IP header; this setting alone never authenticates a request.

For the bundled Caddy alternative, point a domain at the host, set `LOOP_AUTH_MODE=multi-user`, `LOOP_HOST=loop.example.com`, `LOOP_URL=https://loop.example.com` and `LOOP_BEHIND_PROXY=1`, then run `docker compose --profile https up --build -d`. Caddy publishes ports 80/443 and obtains TLS; Loop provides the one account sign-in. Keep the app's HTTP port private.

Use one persistent Loop host. Workspace data and maintained-auth data are in `loop-data`; native credentials are in separate runtime volumes. Back up both SQLite databases with `npm run backup` and secure copies of the generated keys; back up runtime volumes separately if preserving provider sessions. Never copy a live WAL database without its WAL or a consistent SQLite backup. Preserve `LOOP_RUNTIME_TOKEN` across upgrades; it identifies the deployment's runtime namespace. See SUBSCRIPTIONS.md for credential lifecycle and disconnect behavior.

**No public preview has been deployed:** external hosting/tunnel access was not supplied. An actual iPhone install still requires reaching a working HTTPS origin. The connected Workers-only host cannot run the persistent Node/Docker runtime architecture. A dedicated Docker-compatible host or equivalent isolated runtime infrastructure is needed for remote operation.

## iPhone installation and sharing

After the HTTPS deployment passes its smoke checks, open the app in Safari → Share → Add to Home Screen → enable Open as Web App when offered → Add. Launch the icon, sign in and submit a task; close and reopen to check the session and ongoing work. This actual-device gate is pending. Local Chromium viewport tests are not an iPhone test.

On iPhone, copy a source link and use **Bring a link**. For a Shortcut, accept URLs/Text from the Share Sheet, URL Encode the Shortcut Input, build `https://YOUR-LOOP-HOST/share?text=` followed by the encoded value, then Open URLs. The app previews the route and never sends work from a URL visit. A pure URL is detected as the source. Question and optional project may also be passed as encoded `question` and `folder` parameters. Android/desktop browsers supporting Web Share Target use the manifest's `/share` route; native Safari receiving is not assumed.

The service worker caches only public offline UI/icons/manifest. No API response, authentication material or private history enters Cache Storage. Currently displayed content remains readable if the connection drops; offline relaunch shows a neutral reconnect page. Drafts stay in session storage and are cleared on sign-out. Updates wait for explicit Reload to update. No background-send queue exists, so reconnect cannot silently duplicate work.

Official references checked 2026-09-23: [Apple installation](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [Web Share Target and browser compatibility](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target).
