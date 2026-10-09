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

| Check                      | Purpose                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | Root TypeScript                                                                                                 |
| `npm test`                 | Vitest server/domain and shared client production logic in `test/`                                              |
| `npm run test:native`      | Node tests in `test/*.node.test.ts`: adapter protocols, lifecycle and pairing                                   |
| `npm run test:all`         | Both root suites                                                                                                |
| `npm run smoke:package`    | Tarball installation, CLI/host lifecycle and `loop upgrade` between packed builds behind one connection service |
| `npm run test:browser:acp` | Deterministic activity/ACP browser journey                                                                      |
| `npm run feeds:check`      | Reads every Social catalog feed over the network; manual, not in CI                                             |

The [test runner](../scripts/test-runner.mjs) removes inherited `LOOP_*` runtime settings and credentials (except explicit `LOOP_TEST_*` fixture controls) from its child environment. Vitest starts with `LOOP_PROFILE=server`; individual companion fixtures still choose their own profile. Native fixtures choose their profiles independently. This prevents a companion-launched terminal from injecting live state or disabling memory tests. Both suites share `test/`. The `.node.test.ts` suffix selects Node-runner tests and excludes them from Vitest.

`feeds:check` is the exception to fixture-only testing: it fetches the checked-in [feed catalog](../src/shared/news.ts) through [feed-fetch.ts](../src/server/feed-fetch.ts), the same transport Social uses, and exits non-zero for any feed that no longer parses. Run it when changing the catalog and put its output in the PR. The Vitest suite never reaches a feed.

For a focused Vitest run, invoke it directly, for example `npx vitest run test/runtime-network.test.ts --maxWorkers=1`. Do not append file paths to `npm test --`: the script already supplies `test/`, so that still selects the full directory. On process-limited hosts, use `npm test -- --maxWorkers=1` for the full suite; native runtime fixtures also spawn child processes.

Vitest runs files in parallel workers; Node-runner tests run one file at a time. Tests that exercise stop escalation shorten its waits with `LOOP_TEST_STOP_WAIT_MS` and `LOOP_TEST_STOP_GRACE_MS` instead of sleeping through production timeouts.

Connection-service tests (`test/connection.node.test.ts`, `test/cli-connection.node.test.ts`) run the real service, relay, sockets and CLI with [a fixture cloudflared](../test/fixtures/fake-cloudflared.mjs) selected by `LOOP_TEST_CLOUDFLARED`, which is ignored when `NODE_ENV=production`. `smoke:reconnect` adds a local TLS edge so a paired Chromium or WebKit page crosses `loop restart`. None of these reach Cloudflare: real Quick Tunnel behavior is covered by the Docker companion job (`scripts/compose-companion-smoke.mjs`), the `service-lifecycle` job (`scripts/service-lifecycle-smoke.mjs`, real user systemd units; it installs units in the current user's systemd, so run it only on a disposable machine) and by live acceptance recorded in the PR.

Native async tests use bounded waits from `test/helpers.ts`. Regressions should exercise the production caller and observable behavior, not keep an unused helper alive. Harness fixtures make no model requests and cannot certify authenticated upstream compatibility.

## Browser checks

```sh
npx playwright install --with-deps chromium webkit
npm run smoke:design
npm run smoke:history
npm run smoke:pulls
npm run smoke:social
npm run smoke:companion
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

Smoke scripts create isolated fixture workspaces. `CHROMIUM_PATH` can select an existing Chromium binary. Browser system libraries are required; a dependency failure is not a passing journey. CI uploads generated screenshots from `docs/loop-v0/evidence/`; that path remains an output location, not a maintained legacy architecture guide. ACP browser evidence is generated under `docs/validation/evidence/`.

## Containers and CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) is the authoritative check list. New commits cancel older runs of the same PR. Manual runs and the daily 04:17 UTC default-branch run always execute full coverage. Selected build-input merges also run on `main` to seed caches; ordinary feature merges do not duplicate every PR check.

The dependency classifier in [scripts/ci/changes.mjs](../scripts/ci/changes.mjs) always runs root build/tests, package smoke and both browser engines for code PRs. Client-only and standalone root-test changes skip deployment checks. Individual Docker/Compose/smoke definitions select their deployment jobs. Shared code, dependency changes, helpers, unknown paths, and diff errors run every job. Renames consider both paths. Markdown-only changes skip expensive jobs; executable files under `docs/` do not. The `ci-success` check rejects failures or unexpected skips. Classifier regressions run before job selection.

To request full validation, including comparison with serial design scenarios:

```sh
gh workflow run ci.yml --ref YOUR_BRANCH -f browser_workers=auto
# Use browser_workers=1 or 2 for a controlled comparison on the same commit.
```

CI restores npm downloads keyed by OS, architecture, Node 24 and the lockfile; `verify` saves a missing cache after installation. Default-branch caches can serve unrelated PRs. PR-specific caches expire through GitHub's normal eviction policy; CI does not grant cache-deletion permissions. Installs still use `npm ci`.

Docker Bake builds the current checkout's images directly into the Docker daemon's containerd store, using a separate GitHub cache scope for each image. Compose smokes consume those images with `--no-build`; ordinary local smokes still build. PRs only restore image caches. Manual/default-branch runs export shipped layers (`mode=min`), avoiding per-PR upload costs and large intermediate source-build caches. Export has a best-effort backend timeout; local layer compression can take longer. Misses rebuild normally. Companion and server jobs keep separate disks to leave room for cold builds and image export. The Docker driver shares the build/image store, avoiding a separate multi-GB export/load copy before the smokes. Store configuration runs only on fresh hosted VMs, before any containers start. Docker checks require an actual daemon and shipped-image validation; fixture-only results do not replace them.

Browser jobs install/build on the Ubuntu host, then run fixtures in the Playwright image resolved from `package-lock.json`. The exact host Node 24 runtime is mounted read-only so native modules retain the same ABI; browser libraries come from the image. A launch check catches mismatched/missing browser binaries. The design smoke runs named scenarios with separate databases, servers and browser contexts, at most two at a time. CI defaults to two Chromium workers and one WebKit worker; manual runs can override this. `smoke:journey` remains the integrated service-worker/provider journey. For a focused design regression:

```sh
LOOP_BROWSER=webkit node scripts/design-browser-smoke.mjs models
LOOP_BROWSER=chromium LOOP_BROWSER_WORKERS=1 npm run smoke:design
```

Omitting scenario names runs all scenarios; unknown names fail. Each scenario reports timing, and screenshots include its engine/name. Browser evidence and Docker build records are retained for seven days. To roll back an optimisation, restore the host Playwright install for provisioning, select all deployment jobs in the classifier, or remove Bake's cache import/export independently; preserve the smoke assertions.

The native contract checks exercise direct adapter framing, paired sign-in, native session recovery, live steering and team messaging across harnesses. They use subprocess fixtures and do not verify real provider OAuth or inference.

Before a PR, run checks relevant to the change and report exact failures or unavailable dependencies. Documentation-only changes need valid relative links/anchors, real package commands and consistency with current CLI/configuration. Keep dated results in the PR. Real account inference, permission round trips, tunnel behavior and physical-phone installation remain separate live checks requiring the corresponding environment.
