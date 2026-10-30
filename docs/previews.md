# Experiment previews

Use a preview to try a Loop55 branch before merging it. Each named preview has its own application build, database, encryption key, paired devices and connection service. It runs alongside the everyday workspace. No preview command merges a branch, installs Loop55 globally or changes the login service.

Use Node 24. Build the checkout containing this launcher once with `npm ci && npm run build`. Run its CLI as `node dist/cli.js preview …`, or use `loop55 preview …` when that version is installed. The experiment's branch must also contain the preview implementation.

## Create and iterate

From a Loop55 checkout:

```sh
loop55 preview create posts
```

This creates a `preview/posts-…` branch and a separate worktree from the current committed `HEAD`, installs its dependencies, builds it and prints a phone pairing QR/link. It prints the worktree path to edit. The parent checkout keeps its branch and edits. A dirty starting checkout requires an explicit `--from REF`, or the existing-checkout flow below; local changes are never silently copied or dropped.

```sh
loop55 preview create posts --from experiment/posts
loop55 preview open posts
loop55 preview rebuild posts
loop55 preview status posts --json
loop55 preview list
loop55 preview logs posts --follow
loop55 preview stop posts
```

`open` prints a new single-use pairing link; it does not launch a desktop browser. Pair the preview separately from the everyday workspace. Rebuild stages the new application before replacing the preview process. A failed build keeps the current application running. The managed connection service keeps its tunnel address and device trust across rebuilds. `stop` also stops that tunnel, so a later `start` can have a new address. See [pairing and recovery](pairing.md).

To preview an agent's existing worktree, including uncommitted changes:

```sh
loop55 preview start posts --project /absolute/path/to/experiment-checkout
```

For an existing name, `start` uses its saved build, state, source and mode. Use `rebuild` to incorporate newer edits. If files change during a build, the launcher refuses to publish it. The new build must be observed in the running application's status before it is reported as serving. A launch failure or uncertain restart is reported for inspection; the launcher never automatically rolls back a database or replays work.

Only one preview build can use a checkout at a time. Other preview commands report that a build is in progress; retry after it finishes.

`--local-only` on creation gives desktop-only access without cloudflared. Each preview has its own cookie name, so multiple local previews can stay paired in one browser. `--public-url https://preview.example.com` requires a bare HTTPS origin and uses your own proxy; forward it to the printed loopback port and update that forwarding after a restart. Give previews separate browser hostnames for phone installations and browser-storage isolation. Source, mode and connection choices are fixed for each name; create another preview to change them.

## Design and working previews

The default is `--mode design`. It seeds sample agents, a long conversation, completed work, a running task, an approval, a failure and queued work. Messages receive clearly labelled simulated replies; approval decisions are simulated locally. Rebuilds preserve sample-state edits and never seed it twice.

Design mode starts no real worker, native harness, scheduler, notification sender or MCP dispatcher. Its HTTP boundary permits the local reading and interaction routes used by the sample UI and rejects integration actions, native history, local file browsing and provider setup, including discovery through GET requests. Features outside that supported subset show an unavailable-action message. An ordinary Loop55 process refuses to open preview state without its matching manifest; design data cannot be opened as working-preview data.

For actual runtime or integration testing:

```sh
loop55 preview create runtime-test --mode working --providers codex
```

Working mode starts the normal companion with fresh state and no sample data. Native harnesses retain the host's sign-ins and OS-level filesystem access. Use a dedicated container or VM when you need separate credentials or filesystem confinement. Both modes disable automatic linking/proxying of other local Loop55 workspaces. Do not copy the production database, credentials or queued jobs into a preview.

Working-preview rebuilds refuse while runs are active. `--force` explicitly interrupts them using Loop55's ordinary restart/recovery behavior; uncertain effects are never resent automatically.

## Build identity and storage

The app shows **Preview · name**, its mode and expandable build details. `preview status --json` reports the manifest supplied by the running process: a build ID, branch, commit, whether local edits were present, source hash, application artifact hash and build time. These identify the preview being served; they do not assert that the branch is merged or that a browser has reloaded its cached assets. Follow **Reload to update** when the app offers it.

Application files are copied into separate build directories. Dependencies are linked to the source checkout's `node_modules`; keep that checkout in place and stop its previews before replacing dependencies with `npm ci`. Run a lockfile install after dependency changes, then rebuild. Old builds remain until discard so an uncertain restart retains its evidence.

Preview storage defaults to `~/.local/state/loop55-previews`; `LOOP55_PREVIEWS_DIR` selects a different registry. The launcher removes inherited `LOOP55_*` state, runtime, tunnel and service configuration before starting a preview. Each runtime has its own state marker and cannot change modes.

```sh
loop55 preview discard posts
```

Discard stops the named runtime and removes its database, pairing, logs, build copies and registration. **It preserves the source worktree, branch and uncommitted edits.** Keep useful changes in a pull request and merge through the normal review workflow. Remove a discarded Git worktree/branch separately when its code is no longer needed.

## Verification

After `npm run build`, run `node --import tsx --test test/preview-launcher.node.test.ts` for the production CLI lifecycle and `npx vitest run test/preview-launcher.test.tsx` for environment and banner checks. Set `LOOP55_TEST_PREVIEW_BROWSER=1` for the optional Chromium phone-layout journey; `CHROMIUM_PATH` selects an installed browser. The contract tests use a local tunnel fixture and a scripted native harness. They do not validate a live Cloudflare tunnel, provider account or physical phone.
