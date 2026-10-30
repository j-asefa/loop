# Development and verification

Use Node 24 and lockfile installs. [AGENTS.md](../AGENTS.md) routes contributors to the relevant guide.

## Build and local development

```sh
npm ci
npm run setup
npm run build
```

`npm run build` copies `package-lock.json` to the ignored `npm-shrinkwrap.json` for packaging, and `npm ci` prefers that copy. If `npm ci` reports packages missing from the lock file after a pull, delete `npm-shrinkwrap.json` and run it again; `bash install` does this itself.

The root build typechecks, builds the Vite UI/service worker and bundles CLI/server modules. For source development run `npm run dev` and `npm run worker` in separate terminals. Optionally run `npm run ui` for Vite at port 5173 and set `LOOP55_URL` consistently for browser-origin checks. `npm start` starts only the API and expects environment configuration already loaded.

Typechecking uses an incremental cache at `.tmp/typecheck.tsbuildinfo`, local to
each checkout. Repeated `npm run typecheck` and `npm run check` invocations reuse
it; `npm run typecheck -- --watch` keeps a checker running during edits. The
cache can be deleted to force a fresh check. Clean builds check an immutable
temporary source archive, so their cache is temporary as well. Incremental
checking reduces repeated work; it does not impose a hard memory limit or
reduce the scope of the full check.

For design or runtime experiments before merging, use [experiment previews](previews.md). `loop55 preview create NAME` creates a separate branch, build and paired workspace; design previews use sample data and simulated replies by default.

## Database migrations

Add SQL under `migrations/` as `<numeric-prefix>-<unique-name>.sql`. Prefixes
order migrations numerically; files with the same prefix run in name order.
Names identify migrations permanently. Choose a new descriptive name, keep it
unchanged after release, and leave completed migrations intact. Renumbering a
file changes its order for new databases but does not make an existing database
run that name again. Account for dependencies when choosing an order.

The API and worker use the same immediate startup transaction. The runner records
successful files in `schema_migrations(name,prefix,applied_at)`; new SQL must not
write completion records, including `schema_version`. Duplicate names and new
files that write a completion ledger fail startup. If any file fails, all changes
in that startup transaction roll back before another process can migrate.

`legacy-migrations.ts` freezes the old number-to-name mapping through prefix 121
and its historical branch repairs. A one-time translation normalizes those old
branch numbers, copies the applied history, and commits a translation marker in
the same transaction. Afterward, completion decisions use only the named ledger.
Do not extend the frozen mapping for new migrations. Historical SQL retains its
old completion inserts for fresh installs, so `schema_version` remains a
compatibility table; its contents are not the current applied set. An unknown
legacy version fails translation rather than guessing which migration it meant.

## Build provenance

`npm run build` gives the browser and server one build identity. A clean checkout of `github.com/j-asefa/loop` builds from an immutable Git archive, with up to 10,000 ancestor commits embedded only in the server. Runtime helpers, migrations and package metadata are staged in `dist/support`, and compiled module imports and resource URLs point there. Edits made to the source checkout while that build runs do not enter its output. Dirty, Git-less and other-repository builds still work but cannot establish commit inclusion. Production artifacts retain their identity when packed and installed; source-mode processes remain unverified. The running process uses compiled metadata, not the current checkout's HEAD. Replacing a running installation's files invalidates its clean provenance until restart.

For a Docker image with source provenance, use `npm run build:image -- -t loop55:local` (server), or `npm run build:image -- -f Dockerfile.companion -t loop55-companion:local`. The wrapper gives Docker the same immutable source archive plus its build-time identity. Plain Docker/Compose builds remain supported with unknown Git provenance because `.git` is excluded from their context. The server image starts the compiled API and worker. The authenticated `/api/build` response describes the serving process and fresh API/worker observations without credentials or local paths. Processes report every five seconds; observations expire after twenty seconds without a heartbeat. The browser compares its embedded build with the authenticated origin on connection, reconnect and periodic checks; a mismatch offers a reload without submitting work. This signal is local to that browser.

Runtime helpers are compiled by `scripts/compile-runtime.mjs` into standalone
`.mjs` modules. Package builds stage that graph in `dist/support/runtime`; the
runtime and broker Dockerfiles use the same compiler and copy its output into
`/runtime`. TypeScript source imports are rewritten to the compiled siblings.
The final runtime images do not need a TypeScript loader or build dependencies.

## Tests by boundary

| Check                      | Purpose                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | Root TypeScript                                                                                                 |
| `npm run check`            | Convention gate before every PR: formatting, typecheck, `openapi:check`, source boundaries and route contracts  |
| `npm test`                 | Vitest server/domain and shared client production logic in `test/`                                              |
| `npm run test:native`      | Node tests in `test/*.node.test.ts`: adapter protocols, lifecycle and pairing                                   |
| `npm run test:all`         | Both root suites                                                                                                |
| `npm run smoke:package`    | Tarball installation, CLI/host lifecycle and `loop55 upgrade` between packed builds behind one connection service |
| `npm run test:browser:acp` | Deterministic activity/ACP browser journey                                                                      |
| `npm run feeds:check`      | Reads every Social catalog feed over the network; manual live check                                             |

The [test runner](../scripts/test-runner.mjs) removes inherited `LOOP55_*` runtime settings and credentials (except explicit `LOOP55_TEST_*` fixture controls) from its child environment. Vitest starts with `LOOP55_PROFILE=server`; individual companion fixtures still choose their own profile. Native fixtures choose their profiles independently. This prevents a companion-launched terminal from injecting live state or disabling memory tests. Both suites share `test/`. The `.node.test.ts` suffix selects Node-runner tests and excludes them from Vitest.

`feeds:check` is the exception to fixture-only testing: it fetches the checked-in [feed catalog](../src/shared/news.ts) through [feed-fetch.ts](../src/server/feed-fetch.ts), the same transport Social uses, and exits non-zero for any feed that no longer parses. Run it when changing the catalog and put its output in the PR. The Vitest suite never reaches a feed.

For a focused Vitest run, invoke it directly, for example `npx vitest run test/runtime-network.test.ts --maxWorkers=1`. Do not append file paths to `npm test --`: the script already supplies `test/`, so that still selects the full directory. Vitest defaults to two workers in [vite.config.ts](../vite.config.ts). Repository checks use [command supervision](#command-supervision). On process-limited hosts, use `npm test -- --maxWorkers=1` for the full suite; native runtime fixtures also spawn child processes.

The workspace-event socket suite compiles the current server into an isolated temporary fixture, so focused tests do not require or reuse the checkout's `dist` build.

Vitest runs files in parallel workers; Node-runner tests run one file at a time. A card fixture server started inside a test closes when that test finishes; one started in `beforeAll` must be closed in `afterAll`, and each holds about 250 MiB. Tests that exercise stop escalation shorten its waits with `LOOP55_TEST_STOP_WAIT_MS` and `LOOP55_TEST_STOP_GRACE_MS` instead of sleeping through production timeouts.

Reuse prepared statements when generating large SQLite fixtures. Repeatedly
compiling trigger-heavy writes can retain substantial native memory before
JavaScript garbage collection runs; `--max-old-space-size` does not cap those
allocations. Keep bulk read-test setup separate from small tests of producer
behavior. On a shared production host, also use the
[agent resource budget](server.md#keep-agent-workloads-from-exhausting-the-server):
worker counts and JavaScript heap limits are not whole-process memory limits.

Connection-service tests (`test/connection.node.test.ts`, `test/cli-connection.node.test.ts`) run the real service, relay, sockets and CLI with [a fixture cloudflared](../test/fixtures/fake-cloudflared.mjs) selected by `LOOP55_TEST_CLOUDFLARED`, which is ignored when `NODE_ENV=production`. `smoke:reconnect` adds a local TLS edge so a paired Chromium or WebKit page crosses `loop55 restart`. None of these reach Cloudflare: real Quick Tunnel behavior is covered by the Docker companion smoke (`scripts/compose-companion-smoke.mjs`), the service lifecycle smoke (`scripts/service-lifecycle-smoke.mjs`, real user systemd units; it installs units in the current user's systemd, so run it only on a disposable machine) and by live acceptance recorded in the PR.

Native async tests use bounded waits from `test/helpers.ts`. Regressions should exercise the production caller and observable behavior, not keep an unused helper alive. Harness fixtures make no model requests and cannot certify authenticated upstream compatibility.

## Command supervision

Tests, builds, typechecks and browser checks start immediately. Independent invocations do not share a host-wide test slot, even when an older service still sets `LOOP55_JOB_QUEUE_CONFIG`. Each suite keeps its own worker settings and command supervision; model turns and ordinary file or Git operations also remain concurrent. A host can still [submit a particular command explicitly to Pueue](server.md#queue-commands-explicitly), using `loop55-job run -- COMMAND ...`.

TypeScript 7 runs with `--singleThreaded` to avoid duplicating large checker graphs. The full project is still checked. `GOMEMLIMIT` defaults to `1536MiB` for the compiler only; it is a soft Go heap target, not a process memory ceiling. Node's heap limit does not control this native compiler.

[scripts/heavy-command.mjs](../scripts/heavy-command.mjs) supervises commands. On Linux, Python 3.8+ adopts orphaned descendants and gives cleanup five seconds before escalating to SIGKILL. It also cleans up if the caller dies; killing the supervisor itself with SIGKILL requires the enclosing cgroup to clean up. Queued commands run under the separate queue service, so a test's memory kill need not stop its native harness. On macOS, queued cancellation signals the job's process group; browser scripts must still close their own detached helpers. Without a queue, non-Linux commands launch directly and forward signals.

For explicitly queued commands, output streams back to the command trace, and the original exit status is preserved. Each invocation reports its job ID, running/waiting counts and status every 30 seconds. Use `loop55-job status` or `loop55-job cancel ID`. Cancellation removes waiting work or terminates a running job. If the caller or daemon disappears, Loop55 stops owned work and reports an uncertain failure; it never resubmits the command automatically. An unavailable queue fails an explicit submission; it does not block ordinary checks.

Pueue stores ordering, task state and output. The submitting process sends command arguments and its credential environment to the admitted worker over a local connection, without persisting them in Pueue's task environment. Current clients sign requests and responses without transmitting the authentication key. Updated workers and cancellation commands also support the original client protocol, but only after the OS identifies the connected peer as the same user: Linux uses `/proc/net/tcp`; macOS uses the system `lsof`. Missing ownership evidence refuses the legacy connection. Each current client launches its matching worker, so a source checkout can coexist with a different installed generation. A live caller authorizes execution once. Completed tasks are removed only after their output follower finishes successfully; slow readers delay completion, operator cancellation remains available during that wait, and interrupted output remains in the queue logs. Orphaned completed logs are retained for at least one day and pruned on a later submission once their caller is gone. Commands must still avoid printing secrets.

The old `LOOP55_HEAVY_SLOT`, `LOOP55_HEAVY_WAIT_SECONDS`, `LOOP55_HEAVY_RESERVE_MB` and `LOOP55_HEAVY_SCHEDULING` controls have no effect on current checks. The [agent resource installer](../deployment/install-agent-resources.sh) sets `LOOP55_HEAVY_SCHEDULING=off` for older worktrees. `LOOP55_JOB_QUEUE_CONFIG` selects only an explicit queue command. Native harnesses discard inherited automatic queue settings and no longer receive command wrappers.

Older cancellation tools can stop current jobs using a separate cancellation-only token. That token cannot authorize a worker to execute a command, and those tools never receive the current signing key.

Queue regression tests use isolated local Pueue daemons and no provider accounts. To include them, set `LOOP55_TEST_PUEUE` and `LOOP55_TEST_PUEUED` to absolute paths for the pinned 4.0.4 binaries, then run `node --import tsx --test test/job-control.node.test.ts test/job-queue.node.test.ts`. Without those binaries, control-channel authentication, Unicode transport, executable discovery, classification, protocol-descriptor and unavailable-queue tests still run.

The [agent resource budget](server.md#keep-agent-workloads-from-exhausting-the-server) still limits aggregate agent memory and CPU. Container builds need separate limits because Docker work runs outside the caller's process tree and cgroup.

## Browser checks

```sh
npx playwright install --with-deps chromium webkit
npm run smoke:design
npm run smoke:math
npm run smoke:history
npm run smoke:pulls
npm run smoke:social
npm run smoke:companion
npm run smoke:cards
npm run smoke:feed-events
LOOP55_BROWSER=webkit npm run smoke:companion
npm run smoke:reconnect
LOOP55_BROWSER=webkit npm run smoke:reconnect
npm run smoke:fleet-controls
LOOP55_BROWSER=webkit npm run smoke:fleet-controls
npm run smoke:fleet-traces
LOOP55_BROWSER=webkit npm run smoke:fleet-traces
npm run smoke:fleet-commands
LOOP55_BROWSER=webkit npm run smoke:fleet-commands
npm run smoke:browser
LOOP55_BROWSER=webkit npm run smoke:browser
npm run smoke:journey
LOOP55_BROWSER=webkit npm run smoke:journey
```

`smoke:design`, `smoke:history`, `smoke:workspace`, `smoke:html`, `smoke:social` and `smoke:pulls` run both engines unless `LOOP55_BROWSER` selects one; the other smokes default to Chromium. `smoke:pulls` drives the Pull requests tab against a scripted GitHub ([fake-github.mjs](../scripts/helpers/fake-github.mjs)); it does not reach GitHub. `smoke:social` seeds stories straight into the feed store, so it drives Social's reading, saving, filtering, search and watches without reaching a feed.

`smoke:history` opens a long transcript and verifies that older activity is fetched only when requested, historical file reviews remain available, and live updates keep their own cursor.

`smoke:math` uses the built UI and isolated message fixtures in Chromium and WebKit. It checks math in Feed cards, reading sheets and conversations, delayed and failed asset downloads, local fonts, 320/390px equation scrolling and streamed message updates. Set `LOOP55_BROWSER` to select one engine. It makes no provider requests and does not replace physical-phone validation.

`smoke:fleet-controls` drives the production native-question and sharing UI with source context against an isolated HTTP fixture. It checks read-only and mismatched-machine capabilities, source-bound command IDs, storage failure before dispatch, and source changes during a pending share preview. Reading a preview does not grant permission to send it. This is browser fixture evidence, not a native provider or live tunnel run.

`smoke:fleet-commands` bundles the production typed client and receipt panel and exercises IndexedDB transactions and Web Locks across reloads and concurrent tabs. Its deterministic HTTP receipt server drops a response after acceptance and checks that the next attempt queries the original command. It reloads without the original action body and checks the persisted destination, command ID, action type and digest through the local receipt route. The panel copies a receipt between separate origins, retains an unknown outcome, and aborts a lookup when the signed-in owner changes. Importing a receipt submits no action. This fixture does not validate companion admission, live providers or tunnels; the fleet HTTP tests cover the owning gateway and destination boundaries.

`smoke:fleet-traces` drives the production trace panel against isolated HTTP fixtures with identical entity IDs on two sources. It exercises source-bound artifact reads, pagination and run downloads, including owner/source changes while a response or asynchronous Blob read is pending. It runs no provider or live tunnel.

Use `npm run smoke:workspace -- --notifications-only` to check notification opt-in,
category defaults and persistence in both browser engines without the other workspace journeys.

Smoke scripts create isolated fixture workspaces. `CHROMIUM_PATH` can select an existing Chromium binary. Browser system libraries are required; a dependency failure is not a passing journey. Smoke scripts write generated screenshots to `docs/loop55-v0/evidence/`; that path remains an output location, not a maintained legacy architecture guide. ACP browser evidence is generated under `docs/validation/evidence/`.

`smoke:feed-events` runs Chromium and WebKit against compiled server and paired entrypoints, including a linked source discovered through a fixture Docker command. It blocks HTTP event polling while checking Working-to-Done transitions, retained history, updates during pending reads and reconnect catch-up, then blocks WebSockets to check HTTP fallback and connection status. A Chromium server case checks the HTTP request budget while two Done tabs receive sustained updates. The Files journey checks retained pages and scroll, updates during Load more, multi-page catch-up, failure recovery and source/filter isolation. It does not use a real Docker daemon or a provider.

## Manual verification

GitHub Actions are temporarily removed to avoid hosted-runner costs. Run the relevant checks locally and record results in the PR. The former workflow is available in Git history; the helper scripts in `scripts/ci/` and Docker Bake definitions remain available for manual use or future restoration.

Docker checks require an actual daemon and shipped-image validation; fixture-only results do not replace them. The Docker companion smoke (`node scripts/compose-companion-smoke.mjs`) builds its images by default. The server smoke (`node scripts/compose-smoke.mjs`) expects the server Compose stack to be running; see [server operation](server.md).

The design smoke runs named scenarios with separate databases, servers and browser contexts, one at a time by default. `LOOP55_BROWSER_WORKERS=2` enables two concurrent scenario workers. For a focused design regression:

```sh
LOOP55_BROWSER=webkit node scripts/design-browser-smoke.mjs models
LOOP55_BROWSER=chromium LOOP55_BROWSER_WORKERS=1 npm run smoke:design
```

Set `LOOP55_BROWSER_TRACE_DIR=/tmp/loop55-traces` to capture Playwright traces for failing design scenarios; tracing is opt-in to avoid adding overhead to every run. Failures also print available cgroup memory and CPU pressure counters. Open a saved trace with `npx playwright show-trace /tmp/loop55-traces/<trace>.zip`.

Omitting scenario names runs all scenarios; unknown names fail. Each scenario reports timing, and screenshots include its engine/name. `smoke:journey` remains the integrated service-worker/provider journey.

`npm run smoke:fleet` exercises three isolated compiled companions through local
TLS fixture origins, including controller setup, QR/paste enrollment, directory
status, changed-address repair, handoff and explicit recovery. Set
`LOOP55_BROWSER=chromium` or `LOOP55_BROWSER=webkit` for mobile browser emulation.
It uses the bundled QR decoder with synthetic camera frames and no native
BarcodeDetector. Chromium uses a canvas capture stream; WebKit supplies frames
at the media-element boundary because its headless canvas stream can stall
without emitting frames. Both use the production scanner and local decoder
worker. Harness execution and peer routing are fixtures; this is not physical
camera, provider or Internet tunnel acceptance.

The native contract checks exercise direct adapter framing, paired sign-in, native session recovery, live steering and team messaging across harnesses. They use subprocess fixtures and do not verify real provider OAuth or inference.

Before a PR, run `npm run check` on the commit you are submitting and paste its `check:` lines into the PR; repeat after revisions. The review team reads a snapshot and does not run it. The command runs Prettier's check, [typecheck](../scripts/typecheck.mjs), `openapi:check`, the [source boundary test](../test/source-boundaries.test.ts), the [formatting policy](../test/format-policy.test.ts), the registry route inventory, the workspace event contract and `test/*-contracts.test.ts`, stopping at the first failure. Budget roughly a minute on an idle shared host. Typecheck needs about 2 GiB, and the contract tests use two Vitest workers; the route inventory starts the server twice, once per profile. Run it per submitted PR head, not in a mandatory push hook. It refuses to start without the required local `node_modules` tools or with a different Prettier version; use `npm ci`. It is not the full suite. Also run checks relevant to the change and report exact failures or unavailable dependencies.

TypeScript and JavaScript (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`) in `src/`, `test/` and `scripts/` use the exactly pinned Prettier version with its defaults; `npm run format` rewrites them. The [ignore list](../.prettierignore) names files left unformatted because many open branches edit them. It only shrinks: format a file when its in-flight work lands and remove its entry from both the ignore list and the formatting policy's named allowance. The policy rejects new exemptions, broad patterns and missing paths. Reviewers check that the allowance itself has not grown.

`npm run setup` adds the revisions from [.git-blame-ignore-revs](../.git-blame-ignore-revs) to a file in the common Git directory and configures `blame.ignoreRevsFile` to use it, including when `.env` already exists. Linked worktrees share the setting and file, so an older worktree does not need the tracked file. Setup preserves revisions recorded by newer worktrees; concurrent runs append entries without replacing each other's list. Unavailable commits in shallow clones are skipped with a message; rerun setup after fetching history to include them. The tracked file records only formatting commits; preserve those commits when merging instead of squashing them into functional changes. To resolve formatting conflicts while rebasing an older branch, preserve its code changes and apply the current formatter/configuration before reviewing the result. Formatting reduces noise but does not guarantee a conflict-free rebase.

Documentation-only changes need valid relative links/anchors, real package commands and consistency with current CLI/configuration. Keep dated results in the PR. Real account inference, permission round trips, tunnel behavior and physical-phone installation remain separate live checks requiring the corresponding environment.

Follow the [API boundary](architecture.md#dependencies-and-boundaries) when adding routes or browser calls: use registry contracts through the server registrar and client workspace API.

`npm run openapi:check` checks the generated HTTP document and [event-channel companion](openapi-channels.json) against the unified workspace and Cards contracts. `npm run openapi` regenerates both documents.
`npm run cards:example` runs the source-bound full-collection sync example; see [Cards API](cards-api.md#typed-readers-and-the-example) for its environment.
