# Development and verification

Use Node 24 and lockfile installs. [AGENTS.md](../AGENTS.md) routes contributors to the relevant guide.

## Build and local development

```sh
npm ci
npm run setup
npm run build
```

The root build typechecks, builds the Vite UI/service worker and bundles CLI/server modules. For source development run `npm run dev` and `npm run worker` in separate terminals. Optionally run `npm run ui` for Vite at port 5173 and set `LOOP_URL` consistently for browser-origin checks. `npm start` starts only the API and expects environment configuration already loaded.

## Tests by boundary

| Check                      | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `npm run typecheck`        | Root TypeScript                                                               |
| `npm test`                 | Vitest server/domain and shared client production logic in `test/`            |
| `npm run test:native`      | Node tests in `test/*.node.test.ts`: adapter protocols, lifecycle and pairing |
| `npm run test:all`         | Both root suites                                                              |
| `npm run smoke:package`    | Tarball installation and CLI/host lifecycle in an isolated directory          |
| `npm run test:browser:acp` | Deterministic activity/ACP browser journey                                    |

Both suites share `test/`. The `.node.test.ts` suffix selects Node-runner tests and excludes them from Vitest.

Vitest runs files in parallel workers; Node-runner tests run one file at a time. Tests that exercise stop escalation shorten its waits with `LOOP_TEST_STOP_WAIT_MS` and `LOOP_TEST_STOP_GRACE_MS` instead of sleeping through production timeouts.

Native async tests use bounded waits from `test/helpers.ts`. Regressions should exercise the production caller and observable behavior, not keep an unused helper alive. Harness fixtures make no model requests and cannot certify authenticated upstream compatibility.

## Browser checks

```sh
npx playwright install --with-deps chromium webkit
npm run smoke:design
npm run smoke:companion
LOOP_BROWSER=webkit npm run smoke:companion
npm run smoke:browser
LOOP_BROWSER=webkit npm run smoke:browser
npm run smoke:journey
LOOP_BROWSER=webkit npm run smoke:journey
```

`smoke:design`, `smoke:workspace` and `smoke:html` run both engines unless `LOOP_BROWSER` selects one; the other smokes default to Chromium.

Smoke scripts create isolated fixture workspaces. `CHROMIUM_PATH` can select an existing Chromium binary. Browser system libraries are required; a dependency failure is not a passing journey. CI uploads generated screenshots from `docs/loop-v0/evidence/`; that path remains an output location, not a maintained legacy architecture guide. ACP browser evidence is generated under `docs/validation/evidence/`.

## Containers and CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) is the authoritative check list. Its jobs run in parallel: root test/build (`verify`), one browser-smoke job per engine (`browser`), package smoke, Docker Compose smoke, the companion image and native HAPI transport/compatibility checks. Docker checks require an actual daemon and build the pinned images; do not substitute fixture-only results for them.

The native image compatibility job also runs `native/check-opencode-discovery.mjs` against the image’s guarded OpenCode executable and shipped runner service, with external networking disabled. It checks execution-guard evidence, native model discovery, credential replacement and provider-specific sign-out using disposable synthetic credentials. Locally, pass the guarded executable as the first argument; an optional second argument selects an already-built runner service. Without it, the fixture builds the service from the checkout. This does not verify real OAuth or inference.

That job also applies the HAPI patch to a disposable checkout at `deployment/versions.json`’s exact commit and runs `native/check-opencode-launch.mjs` (with `node --import tsx`) and `native/check-opencode-http.mjs`, each taking the checkout path. These fixtures exercise executable selection, environment isolation, and authenticated compaction/event requests at the patched callers. They do not exercise a complete native model turn through ACP.

Before a PR, run checks relevant to the change and report exact failures or unavailable dependencies. Documentation-only changes need valid relative links/anchors, real package commands and consistency with current CLI/configuration. Keep dated results in the PR. Real account inference, permission round trips, tunnel behavior and physical-phone installation remain separate live checks requiring the corresponding environment.

Run `node native/check-pi-managed-tools.mjs /absolute/path/to/pi` with the pinned Pi executable to verify bundled managed extension loading, authenticated MCP catalog discovery and positive/negative private readiness. It uses a disposable native home and a loopback MCP fixture; it sends no model prompt and does not verify tool execution or live inference.

Native image CI also runs Pi discovery/sign-out and managed extension readiness against the shipped artifacts with external networking disabled. For a local prebuilt-artifact check, pass the runner service as the second argument to `native/check-pi-discovery.mjs`, or the managed extension as the second argument to `native/check-pi-managed-tools.mjs`. These use synthetic credentials and do not certify live sign-in, tool execution or inference.
