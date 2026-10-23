# Development and verification

Use Node 24 and lockfile installs. [AGENTS.md](../AGENTS.md) routes contributors to the relevant guide.

## Build and local development

```sh
npm ci
npm run setup
npm run build
```

The root build typechecks, builds the Vite UI/service worker and bundles CLI/server modules. For source development run `npm run dev` and `npm run worker` in separate terminals. Optionally run `npm run ui` for Vite at port 5173 and set `LOOP_URL` consistently for browser-origin checks. `npm start` starts only the API and expects environment configuration already loaded.

For design or runtime experiments before merging, use [experiment previews](previews.md). `loop preview create NAME` creates a separate branch, build and paired workspace; design previews use sample data and simulated replies by default.

## Build provenance

`npm run build` gives the browser and server one build identity. A clean checkout of `github.com/j-asefa/loop` builds from an immutable Git archive, with up to 10,000 ancestor commits embedded only in the server. Runtime helpers, migrations and package metadata are staged in `dist/support`, and compiled module imports and resource URLs point there. Edits made to the source checkout while that build runs do not enter its output. Dirty, Git-less and other-repository builds still work but cannot establish commit inclusion. Production artifacts retain their identity when packed and installed; source-mode processes remain unverified. The running process uses compiled metadata, not the current checkout's HEAD. Replacing a running installation's files invalidates its clean provenance until restart.

For a Docker image with source provenance, use `npm run build:image -- -t loop:local` (server), or `npm run build:image -- -f Dockerfile.companion -t loop-companion:local`. The wrapper gives Docker the same immutable source archive plus its build-time identity. Plain Docker/Compose builds remain supported with unknown Git provenance because `.git` is excluded from their context. The server image starts the compiled API and worker. The authenticated `/api/build` response describes the serving process and fresh API/worker observations without credentials or local paths. Processes report every five seconds; observations expire after twenty seconds without a heartbeat. The browser compares its embedded build with the authenticated origin on connection, reconnect and periodic checks; a mismatch offers a reload without submitting work. This signal is local to that browser.

Runtime helpers are compiled by `scripts/compile-runtime.mjs` into standalone
`.mjs` modules. Package builds stage that graph in `dist/support/runtime`; the
runtime and broker Dockerfiles use the same compiler and copy its output into
`/runtime`. TypeScript source imports are rewritten to the compiled siblings.
The final runtime images do not need a TypeScript loader or build dependencies.

## Tests by boundary

| Check                      | Purpose                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | Root TypeScript                                                                                                 |
| `npm test`                 | Vitest server/domain and shared client production logic in `test/`                                              |
| `npm run test:native`      | Node tests in `test/*.node.test.ts`: adapter protocols, lifecycle and pairing                                   |
| `npm run test:all`         | Both root suites                                                                                                |
| `npm run smoke:package`    | Tarball installation, CLI/host lifecycle and `loop upgrade` between packed builds behind one connection service |
| `npm run test:browser:acp` | Deterministic activity/ACP browser journey                                                                      |
| `npm run feeds:check`      | Reads every Social catalog feed over the network; manual live check                                             |

The [test runner](../scripts/test-runner.mjs) removes inherited `LOOP_*` runtime settings and credentials (except explicit `LOOP_TEST_*` fixture controls) from its child environment. Vitest starts with `LOOP_PROFILE=server`; individual companion fixtures still choose their own profile. Native fixtures choose their profiles independently. This prevents a companion-launched terminal from injecting live state or disabling memory tests. Both suites share `test/`. The `.node.test.ts` suffix selects Node-runner tests and excludes them from Vitest.

`feeds:check` is the exception to fixture-only testing: it fetches the checked-in [feed catalog](../src/shared/news.ts) through [feed-fetch.ts](../src/server/feed-fetch.ts), the same transport Social uses, and exits non-zero for any feed that no longer parses. Run it when changing the catalog and put its output in the PR. The Vitest suite never reaches a feed.

For a focused Vitest run, invoke it directly, for example `npx vitest run test/runtime-network.test.ts --maxWorkers=1`. Do not append file paths to `npm test --`: the script already supplies `test/`, so that still selects the full directory. On process-limited hosts, use `npm test -- --maxWorkers=1` for the full suite; native runtime fixtures also spawn child processes.

The workspace-event socket suite compiles the current server into an isolated temporary fixture, so focused tests do not require or reuse the checkout's `dist` build.

Vitest runs files in parallel workers; Node-runner tests run one file at a time. Tests that exercise stop escalation shorten its waits with `LOOP_TEST_STOP_WAIT_MS` and `LOOP_TEST_STOP_GRACE_MS` instead of sleeping through production timeouts.

Connection-service tests (`test/connection.node.test.ts`, `test/cli-connection.node.test.ts`) run the real service, relay, sockets and CLI with [a fixture cloudflared](../test/fixtures/fake-cloudflared.mjs) selected by `LOOP_TEST_CLOUDFLARED`, which is ignored when `NODE_ENV=production`. `smoke:reconnect` adds a local TLS edge so a paired Chromium or WebKit page crosses `loop restart`. None of these reach Cloudflare: real Quick Tunnel behavior is covered by the Docker companion smoke (`scripts/compose-companion-smoke.mjs`), the service lifecycle smoke (`scripts/service-lifecycle-smoke.mjs`, real user systemd units; it installs units in the current user's systemd, so run it only on a disposable machine) and by live acceptance recorded in the PR.

Native async tests use bounded waits from `test/helpers.ts`. Regressions should exercise the production caller and observable behavior, not keep an unused helper alive. Harness fixtures make no model requests and cannot certify authenticated upstream compatibility.

## Browser checks

```sh
npx playwright install --with-deps chromium webkit
npm run smoke:design
npm run smoke:history
npm run smoke:pulls
npm run smoke:social
npm run smoke:companion
npm run smoke:cards
npm run smoke:feed-events
LOOP_BROWSER=webkit npm run smoke:companion
npm run smoke:reconnect
LOOP_BROWSER=webkit npm run smoke:reconnect
npm run smoke:browser
LOOP_BROWSER=webkit npm run smoke:browser
npm run smoke:journey
LOOP_BROWSER=webkit npm run smoke:journey
```

`smoke:design`, `smoke:history`, `smoke:workspace`, `smoke:html`, `smoke:social` and `smoke:pulls` run both engines unless `LOOP_BROWSER` selects one; the other smokes default to Chromium. `smoke:pulls` drives the Pull requests tab against a scripted GitHub ([fake-github.mjs](../scripts/helpers/fake-github.mjs)); it does not reach GitHub. `smoke:social` seeds stories straight into the feed store, so it drives Social's reading, saving, filtering, search and watches without reaching a feed.

`smoke:history` opens a long transcript and verifies that older activity is fetched only when requested, historical file reviews remain available, and live updates keep their own cursor.

Smoke scripts create isolated fixture workspaces. `CHROMIUM_PATH` can select an existing Chromium binary. Browser system libraries are required; a dependency failure is not a passing journey. Smoke scripts write generated screenshots to `docs/loop-v0/evidence/`; that path remains an output location, not a maintained legacy architecture guide. ACP browser evidence is generated under `docs/validation/evidence/`.

`smoke:feed-events` runs Chromium and WebKit against compiled server and paired entrypoints, including a linked source discovered through a fixture Docker command. It blocks HTTP event polling while checking Working-to-Done transitions, retained history, updates during pending reads and reconnect catch-up, then blocks WebSockets to check HTTP fallback and connection status. A Chromium server case checks the HTTP request budget while two Done tabs receive sustained updates. The Files journey checks retained pages and scroll, updates during Load more, multi-page catch-up, failure recovery and source/filter isolation. It does not use a real Docker daemon or a provider.

## Manual verification

GitHub Actions are temporarily removed to avoid hosted-runner costs. Run the relevant checks locally and record results in the PR. The former workflow is available in Git history; the helper scripts in `scripts/ci/` and Docker Bake definitions remain available for manual use or future restoration.

Docker checks require an actual daemon and shipped-image validation; fixture-only results do not replace them. The Docker companion smoke (`node scripts/compose-companion-smoke.mjs`) builds its images by default. The server smoke (`node scripts/compose-smoke.mjs`) expects the server Compose stack to be running; see [server operation](server.md).

The design smoke runs named scenarios with separate databases, servers and browser contexts, at most two at a time. For a focused design regression:

```sh
LOOP_BROWSER=webkit node scripts/design-browser-smoke.mjs models
LOOP_BROWSER=chromium LOOP_BROWSER_WORKERS=1 npm run smoke:design
```

Omitting scenario names runs all scenarios; unknown names fail. Each scenario reports timing, and screenshots include its engine/name. `smoke:journey` remains the integrated service-worker/provider journey.

The native contract checks exercise direct adapter framing, paired sign-in, native session recovery, live steering and team messaging across harnesses. They use subprocess fixtures and do not verify real provider OAuth or inference.

Before a PR, run checks relevant to the change and report exact failures or unavailable dependencies. Documentation-only changes need valid relative links/anchors, real package commands and consistency with current CLI/configuration. Keep dated results in the PR. Real account inference, permission round trips, tunnel behavior and physical-phone installation remain separate live checks requiring the corresponding environment.

`npm run cards:check` checks generated Cards OpenAPI against executable schemas and routes.
`npm run cards:example` runs the source-bound full-collection sync example; see [Cards API](cards-api.md#typed-readers-and-the-example) for its environment.
