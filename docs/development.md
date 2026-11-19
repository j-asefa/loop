# Development and verification

Use Node 24 and lockfile installs. [AGENTS.md](../AGENTS.md) routes contributors to the relevant guide. [CLAUDE.md](../CLAUDE.md) only imports it, so edit `AGENTS.md`.

## Build and local development

```sh
npm ci
npm run setup
npm run build
```

`npm run build` copies `package-lock.json` to the ignored `npm-shrinkwrap.json` for packaging, and `npm ci` prefers that copy. If `npm ci` reports packages missing from the lock file after a pull, delete `npm-shrinkwrap.json` and run it again; `bash install` does this itself.

The root build typechecks, builds the Vite UI/service worker into `dist/web` and bundles CLI/server modules. The paired host serves that UI; the Express workspace app handles API requests only.

Typechecking uses an incremental cache at `.tmp/typecheck.tsbuildinfo`, local to
each checkout. Repeated `npm run typecheck` and `npm run check` invocations reuse
it; `npm run typecheck -- --watch` keeps a checker running during edits. The
cache can be deleted to force a fresh check. Clean builds check an immutable
temporary source archive, so their cache is temporary as well. Incremental
checking reduces repeated work; it does not impose a hard memory limit or
reduce the scope of the full check.

For design or runtime experiments before merging, use [experiment previews](previews.md). `loop preview create NAME` creates a separate branch, build and paired workspace; design previews use sample data and simulated replies by default.

## Database migrations

Add SQL under `migrations/` as `<numeric-prefix>-<unique-name>.sql`. Prefixes
order migrations numerically; files with the same prefix run in name order.
Names identify migrations permanently. Choose a new descriptive name, keep it
unchanged after release, and leave completed migrations intact. Renumbering a
file changes its order for new databases but does not make an existing database
run that name again. Account for dependencies when choosing an order.

A migration that removes a feature refuses to run while that feature's records
remain, rather than dropping them or leaving them for code that no longer
handles them. `148-remove-workflows.sql` aborts startup if any workflow,
workflow step, workflow run or run started by a workflow step exists; Loop
provides no upgrade or archival path for those records.

[startDatabase](../src/server/database-startup.ts) initializes the process connection, including migrations; its doc comment lists what it owns and why it refuses a second connection.

The API and worker use the same immediate startup transaction. The runner records
successful files in `schema_migrations(name,prefix,applied_at)`; new SQL must not
write completion records, including `schema_version`. Duplicate names fail startup.
The migration-policy test in `npm run check` rejects checked-in files that write
completion ledgers. If any file fails, all changes
in that startup transaction roll back before another process can migrate.

Historical SQL remains unchanged. [The historical migration fixture](../test/fixtures/historical-migration-names.ts) lists the
files through prefix121 that write `schema_version`; only those immutable files
may write that ledger. New installs execute the whole chain and record every
completion in `schema_migrations`. Restarts consult only that named ledger.
Databases from pre-release builds that have only numbered completion records are
refused; start those with a fresh data directory. Every migration must carry
forward the rows that released versions (v0.1.0 and later) could write, and
readers must accept those values ([AGENTS.md](../AGENTS.md)); a migration test
with historical rows shows it. Rows that only pre-release builds wrote may be
refused.

## Build provenance

`npm run build` writes one validated stamp containing build identity, package release and server-only ancestry. The browser, server, connection bundle, workspace event stream and service-worker cache use that stamp; browser output omits ancestry. `dist/build-id.json` stores the same stamp so a running process can detect installation replacement. A standalone connection-image build records its package release with unverified development provenance. A clean checkout of `github.com/j-asefa/loop` builds from an immutable Git archive, with up to 10,000 ancestor commits embedded only in the server. Migrations, deployment inputs and package metadata are staged in `dist/support`, and compiled module imports and resource URLs point there. Edits made to the source checkout while that build runs do not enter its output. Dirty, Git-less and other-repository builds still work but cannot establish commit inclusion. Production artifacts retain their identity when packed and installed; source-mode processes remain unverified. The running process uses compiled metadata, not the current checkout's HEAD. Replacing a running installation's files invalidates its clean provenance until restart.

The Docker source-capture wrapper uses only Node built-ins so it can run before host dependencies are installed. Its standalone repository check is covered against the shared identity by the dependency-free build-image fixture.

For a Docker image with source provenance, use `npm run build:image -- -t loop-companion:local`; it builds `Dockerfile.companion` unless `-f` selects another Dockerfile. The wrapper gives Docker the same immutable source archive plus its build-time identity. Plain Docker/Compose builds remain supported with unknown Git provenance because `.git` is excluded from their context. The authenticated `/api/build` response describes the serving process and fresh API/worker observations without credentials or local paths. Processes report every five seconds; observations expire after twenty seconds without a heartbeat. The browser compares its embedded build with the authenticated origin on connection, reconnect and periodic checks; a mismatch offers a reload without submitting work. This signal is local to that browser.

`src/shared/build-assets.ts` lists runtime support inputs, preview inputs, published files and build outputs copied back from immutable archives. After changing published entries, run `node scripts/package-files.mjs --write` to update `package.json.files`; `npm run check` rejects drift.

`package.json.engines.node` owns the minimum Node version used by the source installer and CLI help. The pre-install check uses only Node built-ins, so it runs before dependencies are installed.

Runtime helpers live in their owning shared, adapter or server layer under `src/` and use the same TypeScript compilation as the rest of that graph. Their compiled modules retain those boundaries under `dist/`.

## Tests by boundary

| Check                      | Purpose                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`        | Root TypeScript                                                                                                                |
| `npm run check`            | Convention gate before every PR: formatting, typecheck, `openapi:check`, source boundaries, guidance links and route contracts |
| `npm test`                 | Vitest server/domain and shared client production logic in `test/`                                                             |
| `npm run test:native`      | Node tests in `test/*.node.test.ts`: adapter protocols, lifecycle and pairing                                                  |
| `npm run test:all`         | Both root suites                                                                                                               |
| `npm run smoke:package`    | Tarball installation, CLI/host lifecycle and `loop upgrade` between packed builds behind one connection service                |
| `npm run test:browser:acp` | Deterministic activity/ACP browser journey                                                                                     |
| `npm run feeds:check`      | Reads every Social catalog feed over the network; manual live check                                                            |

[Guidance links](../test/guidance-links.test.ts) checks that every path, `@` import and heading anchor linked from `AGENTS.md`, `CLAUDE.md`, `docs/*.md`, nested `AGENTS.md` and `CLAUDE.md` files under `src/`, `test/` and `migrations/`, and `.claude/rules/*.md` exists, and that every Claude rule's `paths:` glob matches a file. It also keeps each guidance page under 40,000 bytes (the generated SQL index excepted) and each prose line under 2,000 characters; split a large page by moving whole sections and leaving a pointer under each old heading. It does not fetch external URLs.

The [test runner](../scripts/test-runner.mjs) removes inherited `LOOP_*` runtime settings from its child environment, preserving only explicit `LOOP_TEST_*` fixture controls. Vitest and native fixtures choose isolated data directories; no deployment profile is selected. Native harness launches also remove host configuration before any project command runs; see [server environment isolation](server.md#keep-agent-workloads-from-exhausting-the-server). Both suites share `test/`. The `.node.test.ts` suffix selects Node-runner tests and excludes them from Vitest.

`feeds:check` is the exception to fixture-only testing: it fetches the checked-in [feed catalog](../src/shared/news.ts) through [feed-fetch.ts](../src/server/feed-fetch.ts), the same transport Social uses, and exits non-zero for any feed that no longer parses. Run it when changing the catalog and put its output in the PR. The Vitest suite never reaches a feed.

For a focused Vitest run, invoke it directly, for example `npx vitest run test/runtime-network.test.ts --maxWorkers=1`. Do not append file paths to `npm test --`: the script already supplies `test/`, so that still selects the full directory. Vitest defaults to two workers in [vite.config.ts](../vite.config.ts). Repository checks use [command supervision](#command-supervision). On process-limited hosts, use `npm test -- --maxWorkers=1` for the full suite; native runtime fixtures also spawn child processes.

The workspace-event socket suite compiles the current server into an isolated temporary fixture, so focused tests do not require or reuse the checkout's `dist` build.

Vitest runs files in parallel workers; Node-runner tests run one file at a time. A card fixture server started inside a test closes when that test finishes; one started in `beforeAll` must be closed in `afterAll`, and each holds about 250 MiB. Tests that exercise stop escalation shorten its waits with `LOOP_TEST_STOP_WAIT_MS` and `LOOP_TEST_STOP_GRACE_MS` instead of sleeping through production timeouts.

Reuse prepared statements when generating large SQLite fixtures. Repeatedly
compiling trigger-heavy writes can retain substantial native memory before
JavaScript garbage collection runs; `--max-old-space-size` does not cap those
allocations. Keep bulk read-test setup separate from small tests of producer
behavior. On a shared production host, also use the
[agent resource budget](server.md#keep-agent-workloads-from-exhausting-the-server):
worker counts and JavaScript heap limits are not whole-process memory limits.

Connection-service tests (`test/connection.node.test.ts`, `test/cli-connection.node.test.ts`) run the real service, relay, sockets and CLI with [a fixture cloudflared](../test/fixtures/fake-cloudflared.mjs) selected by `LOOP_TEST_CLOUDFLARED`, which is ignored when `NODE_ENV=production`. `smoke:reconnect` adds a local TLS edge so a paired Chromium or WebKit page crosses `loop restart`. None of these reach Cloudflare: real Quick Tunnel behavior is covered by the Docker companion smoke (`scripts/compose-companion-smoke.mjs`), the service lifecycle smoke (`scripts/service-lifecycle-smoke.mjs`, real user systemd units; it installs units in the current user's systemd, so run it only on a disposable machine) and by live acceptance recorded in the PR.

Vitest runs [test/setup.ts](../test/setup.ts) before each file. It creates a fresh temporary data directory and encryption key without importing the database. Files call `testDirectory()` from [test-workspace.ts](../test/helpers/test-workspace.ts) before importing the database, using its return value when they need the path. The data directory lives under an owned temporary root; `testRootDirectory()` returns that root when harness homes, executables or project fixtures must remain siblings of the data directory. Neither guard changes the environment. The guard refuses directories not owned by the fixture factory, so missing setup fails before opening a live workspace. Files still close their own databases, servers and children in `afterAll`; the configured stack hook order removes the setup-owned directory afterward. Fixtures that override environment values own their additional resources. Native fixtures outside Vitest can use `createTestWorkspace()` and close it explicitly; that factory does not change the environment.

Route fixtures use [productionApp()](../test/helpers/app.ts) to mount their selected production routers under `/api` with the production error handler. Omitting routers mounts mobile, core and workspace in production order. The owner argument supplies fixture identity; cross-owner cases can opt into an `ownerHeader` such as `x-owner`. Pass `undefined` as the fallback owner when only the request header should supply identity. Set `jsonLimit` only when a fixture requires a different parser bound. Use `json: false` when a selected router owns parsing or requires credential checks before its parser. These fixture options are not production authentication. Close the returned app before closing its database or workspace.

Current connection fixtures can use [seedConnection()](../test/helpers/seed.ts), which checks the scalar persisted-row schema and delegates to the per-table SQL writer. Callers supply identity, owner, stored secret, serialized models and timestamp; optional row fields retain explicit overrides. JSON strings are stored unchanged. `seedMessage()` in the same module validates only the message columns it inserts, delegates to the message SQL writer, and leaves transcript ordinals and revisions database-managed. Historical schema, explicit rowid, malformed-record and migration fixtures keep their intentional storage shapes explicit rather than normalizing them through a current-row factory.

`seedAgent()` validates the scalar agent row while preserving both display and normalized names and nullable connections. It owns a fixture insert because the production creation writer couples the two names and requires a connection. Its optional fields use the SQLite storage defaults, including the pre-trigger origin; existing database triggers still apply.

`seedConversation()` similarly uses a fixture insert to retain nullable agents and the complete scalar row; runtime creation variants require an agent and cover different column subsets. Conversation defaults match SQLite storage, and existing origin triggers still apply.

`seedRun()` requires state, idempotency key and both timestamps explicitly, and validates the scalar run row without changing serialized payloads. It uses a fixture insert because the queued writer fixes the state and the preview writer couples the key and timestamps. Optional values retain SQLite defaults; database triggers still apply. Seed functions return their validated input, not a post-trigger database read.

Native async tests use bounded waits from `test/helpers/wait.ts`. Regressions should exercise the production caller and observable behavior, not keep an unused helper alive. Harness fixtures make no model requests and cannot certify authenticated upstream compatibility.

### Memory recall replay evaluation

Fixture tests show recall works; they cannot show it recalls the right things. [scripts/memory-recall-eval.ts](../scripts/memory-recall-eval.ts) is a proxy measure on a copy of a real workspace. For each saved result, the prompt that produced it is a known-item query, and recall should find that result. Prompts from conversations with no artifact saved to memory measure how often recall adds nothing. Search excludes the prompt’s own conversation, including any message sources it contains. It calls production `searchMemory` and reports hit@1/@5, MRR, abstain rates, how much of the query the excerpt shows, injected characters and search latency.

```sh
eval_dir=$(mktemp -d /var/tmp/memory-eval.XXXXXXXX)
mkdir -m 700 "$eval_dir/pristine" "$eval_dir/base" "$eval_dir/head"
LOOP_DATA_DIR="$eval_dir/pristine" node --import tsx scripts/memory-recall-eval.ts \
  --copy-from "/path/to/workspace/loop.db" --copy-only
# Run from the base checkout, then from the head checkout once both have the evaluator.
LOOP_DATA_DIR="$eval_dir/base" node --import tsx scripts/memory-recall-eval.ts \
  --copy-from "$eval_dir/pristine/loop.db" --json "$eval_dir/base.json"
LOOP_DATA_DIR="$eval_dir/head" node --import tsx scripts/memory-recall-eval.ts \
  --copy-from "$eval_dir/pristine/loop.db" --json "$eval_dir/head.json"
node --import tsx scripts/memory-recall-eval.ts --compare "$eval_dir/base.json" "$eval_dir/head.json"
```

`--copy-from` opens the source database read-only and copies, in one read snapshot, only the tables recall reads (never connections or review snapshots) into a fresh, migrated database. The script writes only to a private (`0700`), initially empty `LOOP_DATA_DIR` that a finished `--copy-from` filled. The copy holds the owner's work: keep it and the JSON local, and put only the aggregate table in a PR. Each run captures memory into its copy, so compare builds on separate copies of one pristine snapshot (`--copy-only` makes one; later copies can take its `loop.db` as `--copy-from`), with the same seed and limit (`--seed`, `--limit`, default 1 and 500). Use a fresh output filename and a separate data directory for each run. The replay measures retrieval and excerpt delivery. It does not simulate native-session receipt suppression, and its table copy omits mail-delivery state used to admit previously uncaptured automation messages. The comparison refuses reports whose sampled queries or target annotations differ.

To establish the initial baseline before the evaluator exists on the base branch, use the evaluator checkout for both runs. Its extraction of search and evidence formatting preserves the base recall behavior. For later changes, use each checkout’s own implementation.

The temporal cohort replays the same known-item prompts with a date phrase derived from each target’s update timestamp. Relative phrases use a fixed UTC reference for each query. The owner copy supplies historical candidates across dates, and the temporal fixture places otherwise identical decoys outside the requested window.

Capture stops when a pass leaves the memory index unchanged. A production message-capture batch filled with blank or oversized messages can prevent later messages from reaching the index, since those rejected rows remain candidates. The proxy captures with that same production limit.

## Command supervision

Tests, builds, typechecks and browser checks start immediately; independent invocations never wait for a shared host slot. Each suite keeps its own worker settings and command supervision; model turns and ordinary file or Git operations also remain concurrent.

TypeScript 7 runs with `--singleThreaded` to avoid duplicating large checker graphs. The full project is still checked. `GOMEMLIMIT` defaults to `1536MiB` for the compiler only; it is a soft Go heap target, not a process memory ceiling. Node's heap limit does not control this native compiler.

[scripts/heavy-command.mjs](../scripts/heavy-command.mjs) supervises commands. On Linux, Python 3.8+ adopts orphaned descendants and gives cleanup five seconds before escalating to SIGKILL. It also cleans up if the caller dies; killing the supervisor itself with SIGKILL requires the enclosing cgroup to clean up. On other platforms, commands launch directly and forward signals. Pass `--browser-dispatch` before Node options when wrapping a browser script that dispatches its engines into child processes. The flag lets the dispatcher detect when the wrapper exits. Browser workers isolate their temporary fixtures and register directory removal before starting setup. Shared signal cleanup and normal exit both remove the directory. Browser scripts close their own detached helpers.

The [agent resource budget](server.md#keep-agent-workloads-from-exhausting-the-server) still limits aggregate agent memory and CPU. Container builds need separate limits because Docker work runs outside the caller's process tree and cgroup.

## Browser checks

On Linux, install Python 3.8+ as `python3` for command supervision, including direct smoke commands that dispatch both browser engines. Install both Playwright engines for dual-engine runs.

```sh
npx playwright install --with-deps chromium webkit
npm run smoke:design
npm run smoke:math
npm run smoke:display
npm run smoke:history
npm run smoke:pulls
npm run smoke:social
npm run smoke:companion
npm run smoke:cards
npm run smoke:feed-events
LOOP_BROWSER=webkit npm run smoke:companion
npm run smoke:reconnect
LOOP_BROWSER=webkit npm run smoke:reconnect
node scripts/harness-upgrades-browser-smoke.mjs
npm run smoke:fleet-controls
LOOP_BROWSER=webkit npm run smoke:fleet-controls
npm run smoke:fleet-traces
LOOP_BROWSER=webkit npm run smoke:fleet-traces
npm run smoke:fleet-commands
LOOP_BROWSER=webkit npm run smoke:fleet-commands
```

Dual-engine smokes run Chromium and WebKit by default. Set `LOOP_BROWSER=chromium` or `LOOP_BROWSER=webkit` to select one engine for those scripts. The companion, reconnect and fleet commands above use explicit WebKit invocations because those scripts default to Chromium. The first stage of `smoke:cards` requires Chromium. To run the card content and window checks in WebKit:

```sh
LOOP_BROWSER=webkit node scripts/heavy-command.mjs --browser-dispatch --import tsx scripts/cards-content-browser.mjs
LOOP_BROWSER=webkit node scripts/heavy-command.mjs --browser-dispatch scripts/cards-window-browser.mjs
```

Each script in the table below describes its coverage in the header comment.

| Check                                                                | Script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke:history`                                                      | [conversation-history-smoke.mjs](../scripts/conversation-history-smoke.mjs)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `smoke:display`                                                      | [display-browser-smoke.mjs](../scripts/display-browser-smoke.mjs)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `smoke:math`                                                         | [math-browser-smoke.mjs](../scripts/math-browser-smoke.mjs)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `smoke:pulls`                                                        | [pull-requests-smoke.mjs](../scripts/pull-requests-smoke.mjs)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `smoke:social`                                                       | [social-browser-smoke.mjs](../scripts/social-browser-smoke.mjs)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `smoke:feed-events`                                                  | [feed-websocket-smoke.mjs](../scripts/feed-websocket-smoke.mjs), [personal-files-events-smoke.mjs](../scripts/personal-files-events-smoke.mjs)                                                                                                                                                                                                                                                                                                                                                 |
| `smoke:fleet-controls`, `smoke:fleet-commands`, `smoke:fleet-traces` | [fleet-controls-browser-smoke.mjs](../scripts/fleet-controls-browser-smoke.mjs), [fleet-command-browser-smoke.mjs](../scripts/fleet-command-browser-smoke.mjs), [fleet-traces-browser-smoke.mjs](../scripts/fleet-traces-browser-smoke.mjs)                                                                                                                                                                                                                                                    |
| Harness upgrades, send receipts, fleet Feed, Feed transfer           | [harness-upgrades-browser-smoke.mjs](../scripts/harness-upgrades-browser-smoke.mjs), [send-receipts-browser-smoke.mjs](../scripts/send-receipts-browser-smoke.mjs), [fleet-feed-browser-smoke.mjs](../scripts/fleet-feed-browser-smoke.mjs), [feed-transfer-smoke.mjs](../scripts/feed-transfer-smoke.mjs). Run each with `node scripts/heavy-command.mjs <script>`, adding `--import tsx` before the script for `fleet-feed-browser-smoke.mjs`; `feed-transfer-smoke.mjs` needs a build first |

Use `npm run smoke:workspace -- --notifications-only` to check notification opt-in,
category defaults and persistence in both browser engines without the other workspace journeys.

Smoke scripts create isolated fixture workspaces. `CHROMIUM_PATH` can select an existing Chromium binary. Browser system libraries are required; a dependency failure is not a passing journey. Set `LOOP_SCREENSHOT_DIR` to collect screenshots from the design, approval layout, Social, pull requests, HTML preview, display and workspace lifecycle smokes. The scripts also accept their existing per-smoke variables. In CI, design, approval layout, Social, pull requests and HTML preview default to `test-results/screenshots/`. ACP browser evidence goes to `test-results/deterministic-browser/`.

The companion sign-in fixture also shadows installed harness commands on PATH.
Its Claude sign-in uses the protocol fixture; other discovered CLIs fail locally
without starting the developer's installations. Browser checks must not launch
real harnesses merely to populate Provider connections.

## Manual verification

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to
`main` and manual dispatch, using Node 24 and Python 3.12 on Ubuntu runners. The
`check` job installs with `npm ci` and runs `npm run check` on a clean source
checkout without building first; it is the required status check for `main`.
The `tests` job builds, then runs the Vitest suite as three parallel shards
(`npm test -- --shard=N/3 --maxWorkers=1`). The native, package and browser
suites still run locally. CI keeps pinned checkout/Node/Python actions,
read-only repository permissions and cancellation of superseded runs on the same
ref; the repository owner controls approval of fork-PR runs.

Each PR body records the submitted commit, the commands run and their exits, and one line
`Canonical example followed: <file>` naming the canonical example from the
[AGENTS.md](../AGENTS.md) index that the change copies, or
`Canonical example followed: none: <reason>`.

### Releases

Pushing a tag `vX.Y.Z` that matches the `package.json` version runs the
[release workflow](../.github/workflows/release.yml). It runs `npm run check`,
stages `@j-asefa/loop` on npm with provenance through npm trusted publishing
(no stored token; `prepack` builds `dist/` and `npm-shrinkwrap.json`), then
drafts the GitHub Release with generated notes. The trusted publisher may only
stage, so the version is not installable until a maintainer approves it with 2FA
(`npm stage list @j-asefa/loop`, then `npm stage approve <stage-id>`, or on
npmjs.com). Publish the draft release after approving. Bump the version in a pull
request first, then tag the merged commit.

During editing and between commits, run focused tests for the changed boundaries.
Immediately before requesting a fresh review, run `npm run check` and one full
local Vitest suite: `npm test -- --shard=1/3 --maxWorkers=1`, then `2/3` and `3/3`.
Server, runtime or CLI changes also require `npm run test:native` before review;
docs/scripts-only changes do not. Run relevant browser, package and Docker checks
for affected behavior. Record the tested commit, commands, exits and limitations
in the PR. Review teams inspect snapshots and do not run these checks.

A fresh review of changed content requires fresh full-suite evidence. Do not
repeat full suites merely for a push or commit that leaves tested content
unchanged; record any commit/tree parity used to carry evidence forward. A failed
check still needs investigation and relevant reruns. Native tests, browser smokes
and Docker validation remain local.

Docker checks require an actual daemon and shipped-image validation; fixture-only results do not replace them. The Docker companion smoke (`node scripts/compose-companion-smoke.mjs`) builds its images by default. For an isolated prebuilt validation, pass `--images-file /absolute/override.yaml` to the companion smoke; the Compose override selects the test images and can set container memory/CPU limits and environment-specific CA mounts. This avoids overwriting shared CI tags. The runner still owns only its unique Compose project and volumes.

The design smoke runs named scenarios with separate databases, servers and browser contexts, one at a time by default. `LOOP_BROWSER_WORKERS=2` enables two concurrent scenario workers. For a focused design regression:

```sh
LOOP_BROWSER=webkit node scripts/design-browser-smoke.mjs models
LOOP_BROWSER=chromium LOOP_BROWSER_WORKERS=1 npm run smoke:design
```

Set `LOOP_BROWSER_TRACE_DIR=/tmp/loop-traces` to capture Playwright traces for failing design scenarios; tracing is opt-in to avoid adding overhead to every run. Failures also print available cgroup memory and CPU pressure counters. Open a saved trace with `npx playwright show-trace /tmp/loop-traces/<trace>.zip`.

Omitting scenario names runs all scenarios; unknown names fail. Each scenario reports timing, and screenshots include its engine/name.

`npm run smoke:fleet` exercises three isolated compiled companions through local
TLS fixture origins, including controller setup, QR/paste enrollment, directory
status, changed-address repair, handoff and explicit recovery. Set
`LOOP_BROWSER=chromium` or `LOOP_BROWSER=webkit` for mobile browser emulation.
It uses the bundled QR decoder with synthetic camera frames and no native
BarcodeDetector. Chromium uses a canvas capture stream; WebKit supplies frames
at the media-element boundary because its headless canvas stream can stall
without emitting frames. Both use the production scanner and local decoder
worker. Harness execution and peer routing are fixtures; this is not physical
camera, provider or Internet tunnel acceptance.

Lifecycle fixtures use [lifecycle-waits.ts](../src/lifecycle-waits.ts) to shorten deadlines without changing recovery paths. Production callers share a 20-second graceful-stop wait, a 5-second forced-stop grace, a 180-second connection-convergence wait and a 120-second connection-start wait. Graceful stop accommodates the application's shutdown; convergence accommodates tunnel/service startup before the application reattaches. Positive integer `LOOP_TEST_*` overrides are for isolated fixtures; invalid values use the production defaults.

The native contract checks exercise direct adapter framing, paired sign-in, native session recovery, live steering and team messaging across harnesses. They use subprocess fixtures and do not verify real provider OAuth or inference.

Before a PR, run `npm run check` on the commit you are submitting and paste its `check:` lines into the PR; repeat after revisions. The review team reads a snapshot and does not run it. The command runs Prettier's check, [typecheck](../scripts/typecheck.mjs), `openapi:check`, the [source boundary test](../test/source-boundaries.test.ts), the [formatting policy](../test/format-policy.test.ts), the registry route inventory, the workspace event contract and `test/*-contracts.test.ts`, stopping at the first failure. Budget roughly a minute on an idle shared host. Typecheck needs about 2 GiB, and the contract tests use two Vitest workers; the route inventory checks the companion's mounted routes. Run it per submitted PR head, not in a mandatory push hook. It refuses to start without the required local `node_modules` tools or with a different Prettier version; use `npm ci`. It is not the full suite. Also run checks relevant to the change and report exact failures or unavailable dependencies.

TypeScript and JavaScript (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`) in `src/`, `test/` and `scripts/` use the exactly pinned Prettier version with its defaults; `npm run format` rewrites them. The formatting policy rejects a repository ignore file; all files in these source directories are checked.

`npm run setup` adds the revisions from [.git-blame-ignore-revs](../.git-blame-ignore-revs) to a file in the common Git directory and configures `blame.ignoreRevsFile` to use it. Linked worktrees share the setting and file, so an older worktree does not need the tracked file. Setup preserves revisions recorded by newer worktrees; concurrent runs append entries without replacing each other's list. Unavailable commits in shallow clones are skipped with a message; rerun setup after fetching history to include them. The tracked file records reachable formatting-only commits. Keep mechanical formatting in its own PR; after squash merge, record that merge SHA in the following PR. Do not record a commit that also changes behavior. To resolve formatting conflicts while rebasing an older branch, preserve its code changes and apply the current formatter/configuration before reviewing the result. Formatting reduces noise but does not guarantee a conflict-free rebase.

Documentation-only changes need valid relative links/anchors, real package commands and consistency with current CLI/configuration. Keep dated results in the PR. Real account inference, permission round trips, tunnel behavior and physical-phone installation remain separate live checks requiring the corresponding environment.

Follow the [API boundary](architecture.md#dependencies-and-boundaries) when adding routes or browser calls: use registry contracts through the server registrar and client workspace API.

`npm run openapi:check` checks the generated HTTP document and [event-channel companion](openapi-channels.json) against the unified workspace and Cards contracts. `npm run openapi` regenerates both documents.
