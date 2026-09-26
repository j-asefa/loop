# Phase 2: CLI command redesign and daemonization

> **As implemented:** line references below are to `c908b96`, before this
> work. The detached process is marked with `LOOP_DAEMON_CHILD=1` and reports
> readiness over a Node IPC channel rather than a stdout line. The escape
> hatch for tests and service managers is the public `--foreground` flag, not
> an environment variable. See `src/cli.ts`, `src/daemon.ts` and
> `TunnelSupervisor` in `src/tunnel.ts`.

## Target command surface

```
loop                               # ALWAYS launches the full Loop server profile
loop codex|claude|pi|opencode      # opens the pairing screen, then backgrounds the
                                    #   harness/companion host and returns the terminal
loop pair | status [--json] | devices | devices revoke ID | doctor [--json]
loop stop | uninstall
loop logs [--follow]               # new — see "Where output goes" below
```

No new command for reconnecting a rotated tunnel — `loop pair` already mints
a fresh QR for the current origin, which is exactly what's needed whether
this is a first pairing or reconnecting an already-installed standalone app.
Its printed message needs a small copy update to read naturally for both
cases; see `03-resync.md`.

`loop server` keeps working as an explicit alias for bare `loop` (some
scripts/docs/tests already say `loop server`; don't break them — see
`docs/UNIFIED-LOOP.md:8` and the `server` branch at `src/cli.ts:69-85`).
`loop claude-code` keeps working as an alias for `loop claude`
(`src/cli.ts:94`, documented at `docs/companion/CLI.md:43`).

### Bare `loop`

Change `src/cli.ts` so that `positionals[0] === undefined` takes the same
branch as today's `positionals[0] === "server"` (`src/cli.ts:69-85`), i.e. it
always starts the server profile in the foreground exactly like `loop server`
does today. Delete the current bare-`loop` behavior at `src/cli.ts:156-169`
(the "already running, just re-pair" shortcut) — that behavior moves to
`loop pair` alone, which already does exactly this
(`src/cli.ts:122-150`, action `"pair"`) and needs no change.

This is a breaking change to documented behavior — `docs/companion/CLI.md`
and `README.md` both currently describe or imply that running `loop` again
with no arguments is a harmless way to see the pairing QR for an existing
companion workspace, and the help text at `src/cli.ts:48-66` needs a rewrite
to match. Update both docs and the help text in the same commit. Search the
whole repo (docs, tests, scripts) for bare `loop ` invocations before
finishing this phase — `grep -rn '\bloop\b' docs scripts test tests
README.md` — and fix every one that assumed the old behavior.

### `loop <harness>`

Today this blocks the foreground terminal until Ctrl-C
(`src/cli.ts:266-344`). It needs to instead:

1. Do everything it does today up through getting the Quick Tunnel origin
   and showing the pairing QR (`showPair(host.pair())` at
   `src/cli.ts:327`/`333`/`336`) — **in the foreground**, so the user sees
   the QR code and pairing instructions before their terminal is handed
   back. Don't background before the tunnel is up; a background process
   that immediately needs the user to scan something is worse than today.
2. Once the tunnel origin is set and the pairing QR has been printed (or, if
   an existing workspace was joined — the `running` branch at
   `src/cli.ts:245-265` — once "Enabled `<harness>` in your existing
   workspace" is printed), **daemonize**: detach from the controlling
   terminal, keep running, and return control of the shell prompt to the
   user.
3. `--local-only` and `--public-url` keep working exactly as today
   (`src/cli.ts:330-340`) — they still print instructions/QR before
   daemonizing.

### Daemonization mechanics

Node has no built-in daemon primitive; implement it explicitly. The
straightforward, well-understood approach:

- On invocation, if not already running detached (mark this with an env var,
  e.g. `LOOP_DAEMONIZED=1`, checked at the very top of `main()`), do the
  foreground setup work described above (tunnel + pairing QR / enable
  message) in the **parent** process using the *existing* code paths
  (`WorkspaceHost`, `Tunnel`, etc. — don't build a second copy of this
  logic).
- Once that setup finishes successfully, `re-exec` a detached child of
  *itself* that takes over the already-running `WorkspaceHost`/`Tunnel`... —
  **except Node can't hand a live child process, open sockets, and
  in-memory state across an exec boundary.** The practical way to do this
  without a rewrite is the inverse: the parent does argument parsing and
  discovery only (harness probe, billing prompt, checking for an existing
  running workspace), then **spawns the detached child first**
  (`spawn(process.execPath, [cliEntry, ...args, ], { detached: true, stdio:
  ["ignore", logFd, logFd], env: { ...process.env, LOOP_DAEMONIZED: "1" } })`
  followed by `child.unref()`), and the **child** is the one that constructs
  `WorkspaceHost`, starts the `Tunnel`, and prints the pairing QR — to its
  log file, not to the now-gone parent TTY.
  - This means the *parent* can't literally "show the QR in the terminal
    before handing back the prompt" by printing from the child. Solve this
    with a small IPC handshake instead: use `spawn(..., { stdio: ["ignore",
    "pipe", "pipe"], detached: true })`, have the parent read the child's
    stdout **until it sees the pairing/enabled message** (the child should
    emit one machine-parseable line, e.g. a single JSON line
    `{"ready":true,"pairUrl":"...","expiresIn":120}` or
    `{"ready":true,"enabled":"codex"}`, in addition to its normal
    human-readable output), print the human-readable QR/message to its own
    (still-attached) stdout, redirect the child's stdio to the log file from
    that point on (`child.stdout.unref()`/close the pipe and reopen against
    the log — or simpler: have the child itself reopen its own stdout/stderr
    to the log file once it has emitted the ready line, and the parent just
    stops reading and exits), then `child.unref()` and exit 0 itself.
  - Keep this handshake protocol internal (undocumented, unstable) — it's
    not a public API, just how the parent and detached child talk during the
    few seconds of startup.
- Write a PID file (e.g. `join(dir, "daemon.pid")`, next to the existing
  `control.json` written by `Host.listen()` at `src/host.ts:191-195`) from
  the child once it's running, and remove it in the same place `control.json`
  is unlinked (`Host.close()`, `src/host.ts:595`).
- `loop stop` (`src/cli.ts:122-150`, action `"stop"`) already POSTs `/stop`
  through `control()` (`src/host-control.ts:64-112`) to the admin server,
  which calls `Host.onStop` (`src/host.ts:563-566`, wired to the CLI's own
  `stop()` closure at `src/cli.ts:292`). That RPC-based stop keeps working
  unmodified against a daemonized process — it doesn't care whether the
  process has a controlling terminal. No change needed here beyond making
  sure the daemon's `stop()` closure still tears down the tunnel and host the
  same way it does today.
- Handle the case where daemonization itself fails (spawn error, child died
  before emitting the ready line, platform doesn't support `detached`) by
  falling back to a clear error, never a silent foreground hang. `detached:
  true` behaves differently on Windows, but `src/cli.ts:86-87` already
  restricts this whole path to `darwin`/`linux` — keep that restriction, no
  need to solve Windows daemonization here.

### Where output goes

Introduce `join(dir, "daemon.log")` (or rotate a couple of files if you want
to be tidy, but a single append-only log is fine for a personal CLI tool —
don't over-build this). Add `loop logs [--follow]` that reads/tails it
(`--follow` = `tail -f`-style, implement with `fs.watch` + read-from-offset,
not by shelling out to `tail`). Mention the log path in the "Enabled ... in
your existing workspace" / pairing-ready messages so a user who wants to
debug a backgrounded process knows where to look, and add it to
`loop doctor`'s JSON output (`src/cli.ts:95-121`).

### `loop status` / `loop doctor` after backgrounding

Both already talk to the running host over the local admin RPC
(`control()`), not by being the same process — no change required to make
them work against a daemonized host, but double check
`src/cli.ts:133-150`'s error message ("No responsive workspace host. Run
`loop codex` first.") still reads correctly now that `loop codex` returns
immediately instead of blocking; you may want to make daemonized-startup
failures more visible here (e.g. `loop status` could check the PID file and
report "workspace failed to start, see `loop logs`" instead of the generic
message, if the PID is dead but `daemon.log` shows a startup error).

### Multiple harnesses, still one host

Nothing about the "one host, multiple harnesses share it" model
(`src/cli.ts:245-265`, the `running` branch) changes. `loop pi` after `loop
codex` is already running still just calls `control(dir, "enable", options)`
against the same daemon and returns immediately — it already doesn't block
today when joining an existing host, so this phase's "background it" work is
really only needed for the *first* `loop <harness>` invocation that starts a
new host from cold. Make sure the join-existing-host branch's UX (prints
"Enabled ... no new pairing is required" and returns) is unaffected.

## Tests to update or add

- `test/host.test.ts`, `test/lifecycle.test.ts` — anything asserting on
  `main()`'s foreground blocking behavior needs to account for
  daemonization; you may need a test-only escape hatch (e.g. respect an env
  var to skip detaching, so `test/`'s existing harness-journey style tests
  can still drive the process in-line) — check `test/helpers.ts` for the
  existing pattern used to drive the CLI under test and follow it rather
  than inventing a new one.
- `scripts/package-smoke.mjs`, `scripts/native-harness-smoke.mjs`,
  `scripts/harness-journey.mjs` — these likely invoke `loop <harness>` and
  wait for output; they'll need updating for the new ready-line/daemon
  protocol.
- Add a new test that: starts `loop codex` against a fixture, asserts the
  parent process exits promptly (not just "eventually"), asserts
  `loop status` against the same `LOOP_HOME` sees a running workspace, and
  asserts `loop stop` actually terminates the detached child (check the PID
  is gone, not just that `control()` returned).

## Definition of done for this phase

- `loop` with no arguments starts the server profile; `loop server` still
  works too.
- `loop codex` (cold start) prints the pairing QR, then returns the shell
  prompt within a couple seconds, and the harness keeps running after the
  terminal is closed.
- `loop status`, `loop pair`, `loop devices`, `loop stop` all work correctly
  against the now-detached process.
- `docs/companion/CLI.md`, `README.md`, and `src/cli.ts`'s `--help` text are
  all updated to match.
- `npm run check`, `npm test`, `npm run test:native` pass.

---

Next: `03-resync.md`.
