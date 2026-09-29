# Development and verification

Use Node 24 and lockfile installs. Root and mobile are separate npm packages. [AGENTS.md](../AGENTS.md) routes contributors to the relevant guide.

## Build and local development

```sh
npm ci
npm run setup
npm run build
```

The root build typechecks, builds the Vite UI/service worker and bundles CLI/server modules. For source development run `npm run dev` and `npm run worker` in separate terminals. Optionally run `npm run ui` for Vite at port 5173 and set `LOOP_URL` consistently for browser-origin checks. `npm start` starts only the API and expects environment configuration already loaded.

## Tests by boundary

| Check                      | Purpose                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | Root TypeScript                                                                              |
| `npm test`                 | Vitest server/domain and shared client production logic in `tests/`                          |
| `npm run test:native`      | Node tests in `test/`: adapter protocols, lifecycle, pairing and mobile connection contracts |
| `npm run test:all`         | Both root suites                                                                             |
| `npm run smoke:package`    | Tarball installation and CLI/host lifecycle in an isolated directory                         |
| `npm run test:browser:acp` | Deterministic activity/ACP browser journey                                                   |

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

Smoke scripts create isolated fixture workspaces. `CHROMIUM_PATH` can select an existing Chromium binary. Browser system libraries are required; a dependency failure is not a passing journey. CI uploads generated screenshots from `docs/loop-v0/evidence/`; that path remains an output location, not a maintained legacy architecture guide. ACP browser evidence is generated under `docs/validation/evidence/`.

## Mobile, containers and CI

[Mobile setup](../mobile/README.md) lists its typecheck, iOS/Android exports and native builds. Root native tests exercise the mobile connection module, but root builds do not build the Expo app.

[.github/workflows/ci.yml](../.github/workflows/ci.yml) is the authoritative check list. It runs root tests/build, Chromium/WebKit journeys, package smoke, mobile typecheck/exports, Docker Compose smoke and native HAPI transport/compatibility checks. Docker checks require an actual daemon and build the pinned images; do not substitute fixture-only results for them.

Before a PR, run checks relevant to the change and report exact failures or unavailable dependencies. Documentation-only changes need valid relative links/anchors, real package commands and consistency with current CLI/configuration. Keep dated results in the PR. Real account inference, permission round trips, tunnel behavior and physical-phone installation remain separate live checks requiring the corresponding environment.
