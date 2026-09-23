# Run and install Loop

## Local setup

Requirements: Node.js 24 and npm, a persistent local disk, and a modern browser. No provider credential is needed to boot or import history.

```sh
npm ci
npm run setup
npm run build
node --env-file=.env scripts/serve.mjs
```

Open http://localhost:3000 and create an account. `serve` starts the API and independent worker. For development use separate terminals: `npm run dev`, `npm run worker`, and optionally `npm run ui` (Vite at port 5173; set LOOP_URL accordingly for auth/origin checks). Workspace and maintained-auth database migrations run on startup. `npm test` runs deterministic tests; `npm run smoke:browser` requires Playwright Chromium (`npx playwright install chromium`) or an explicit `CHROMIUM_PATH`.

Connect your OpenAI or Anthropic API account in Settings. The model list comes from that connection. Provider API keys and MCP secrets are encrypted using LOOP_ENCRYPTION_KEY; never change that key without a migration. Chat exports are a separate Import conversations flow. For subscription usage, run the Docker runtime services and follow SUBSCRIPTIONS.md. API connections remain optional.

## Docker Compose: no domain required

Run `node scripts/setup.mjs` (also upgrades an existing `.env` with a runtime token), then `docker compose up --build -d`. The default stack starts Loop's API/worker, builds the official runtime image, and starts the private Docker runtime broker. Open **http://localhost:3000**. The port binds to 127.0.0.1 by default. For access over a trusted LAN, set `LOOP_BIND_ADDRESS=0.0.0.0` and `LOOP_URL=http://YOUR-SERVER-IP:3000`; plain HTTP LAN access does not provide the full HTTPS PWA behavior.

Connect subscriptions in Settings using [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md). Docker credentials are not provider API credentials. The default installation includes native per-account containers and needs no API key. Docker access belongs only to the private broker, not to the web app or model container. The host must support Docker's Linux containers and persistent volumes.

`GET /api/health` reports API/worker readiness. `docker compose logs -f loop runtime-broker` shows service logs. CI's separate containers job builds the production images, signs up over HTTP and checks unsigned native status through the broker; see the PR for the current result. No authenticated inference is claimed by this smoke check.

## Optional HTTPS for remote/iPhone use

A hosting-provider HTTPS URL or a tunnel pointing to port 3000 works; a custom domain is not required. Set `LOOP_URL` to the actual public HTTPS origin and restart Loop so sessions and origin checks use it. Keep the direct app port private. Set `LOOP_BEHIND_PROXY=1` only when requests can reach the origin exclusively through your trusted proxy.

For the bundled Caddy alternative, point a domain at the host, set `LOOP_HOST=loop.example.com`, `LOOP_URL=https://loop.example.com` and `LOOP_BEHIND_PROXY=1`, then run `docker compose --profile https up --build -d`. Caddy publishes ports 80/443 and obtains TLS. Do not expose the app's HTTP port publicly alongside the trusted-proxy setting.

Use one persistent Loop host. Workspace data and maintained-auth data are in `loop-data`; native credentials are in separate runtime volumes. Back up both SQLite databases with `npm run backup` and secure copies of the generated keys; back up runtime volumes separately if preserving provider sessions. Never copy a live WAL database without its WAL or a consistent SQLite backup. Preserve `LOOP_RUNTIME_TOKEN` across upgrades; it identifies the deployment's runtime namespace. See SUBSCRIPTIONS.md for credential lifecycle and disconnect behavior.

**No public preview has been deployed:** external hosting/tunnel access was not supplied. An actual iPhone install still requires reaching a working HTTPS origin. The connected Workers-only host cannot run the persistent Node/Docker runtime architecture. A dedicated Docker-compatible host or equivalent isolated runtime infrastructure is needed for remote operation.

## iPhone installation and sharing

After the HTTPS deployment passes its smoke checks, open the app in Safari → Share → Add to Home Screen → enable Open as Web App when offered → Add. Launch the icon, sign in and submit a task; close and reopen to check the session and ongoing work. This actual-device gate is pending. Local Chromium viewport tests are not an iPhone test.

On iPhone, copy a source link and use **Bring a link**. For a Shortcut, accept URLs/Text from the Share Sheet, URL Encode the Shortcut Input, build `https://YOUR-LOOP-HOST/share?text=` followed by the encoded value, then Open URLs. The app previews the route and never sends work from a URL visit. A pure URL is detected as the source. Question and optional project may also be passed as encoded `question` and `folder` parameters. Android/desktop browsers supporting Web Share Target use the manifest's `/share` route; native Safari receiving is not assumed.

The service worker caches only public offline UI/icons/manifest. No API response, authentication material or private history enters Cache Storage. Currently displayed content remains readable if the connection drops; offline relaunch shows a neutral reconnect page. Drafts stay in session storage and are cleared on sign-out. Updates wait for explicit Reload to update. No background-send queue exists, so reconnect cannot silently duplicate work.

Official references checked 2026-09-23: [Apple installation](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios), [Web Share Target and browser compatibility](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target).
