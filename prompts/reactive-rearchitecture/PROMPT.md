# Make Loop reactive: implementation assignment

Implement the architectural changes in this bundle in the Loop checkout you are given, one pull request at a time, in the order listed. For each PR: implement, verify, request review from the Loop review team, fix findings, re-review the final code, and merge to `main` once the gate in the process guide is met. The assignment is complete only when every PR in the ledger is merged and `origin/main` contains all of them.

This is an implementation assignment, not a plan. Do not stop at a design, a partial PR, or an open PR awaiting someone else.

## Why

Loop's durability is good. Its reactivity is a facade: every live surface is a timer reading SQLite. The WebSocket is a per-socket 250 ms database poll whose payloads the browser discards, the worker polls for work it just enqueued, each run polls for its own cancellation, and the phone refetches everything on every frame. On the laptop profile the worker shares one thread with the HTTP server, so a thread open waits behind whatever the worker is writing.

The sequence below adds the one missing primitive, an ordered in-process change bus, then makes the event stream a real projection contract in stages: typed invalidations first, then complete coverage of every change the UI depends on, then per-surface deltas with a snapshot handoff, and only then removal of the timers each surface no longer needs. In parallel it moves the companion worker off the request thread behind an extracted ownership boundary, materialises the Feed behind a shadow equivalence test, and finishes with the schema identity, typing and module cleanups the earlier work exposes.

This revision incorporates a design review by @starling (2026-10-22) whose findings are folded into each spec; where a spec says "do not", it is usually because the review found the simpler version loses data.

## Read progressively

1. Read the repository `AGENTS.md`, `README.md`, `docs/architecture.md` and `docs/development.md` first. Then read [process](process.md): branching, pull requests, the review loop with its gate, merging, and the ledger. Follow it for every PR.
2. Read [verification](verification.md) before writing tests for any PR and again before requesting review.
3. Open [STATUS.md](STATUS.md) and find the first PR that is not merged. Read only that PR's spec file, implement it to completion, and update the ledger after every step. Do not read ahead into later specs except where a spec names a later PR that depends on a decision you are making now.
4. PR specs, in order:
   - [PR 1: runtime helpers in TypeScript](pr-01-runtime-typescript.md)
   - [PR 2: the ordered change bus](pr-02-change-bus.md)
   - [PR 3: typed invalidations on the socket](pr-03-typed-invalidations.md)
   - [PR 4: signal-bound runs instead of polling](pr-04-signal-bound-runs.md)
   - [PR 5: thread open from cache](pr-05-thread-open.md)
   - [PR 6: complete change signalling](pr-06-change-log-completeness.md)
   - [PR 7: projection deltas and timer removal](pr-07-projection-deltas.md)
   - [PR 8: companion worker in its own process](pr-08-companion-worker-process.md)
   - [PR 9: materialised feed cards](pr-09-feed-cards.md)
   - [PR 10: migration identity](pr-10-migration-identity.md)
   - [PR 11: typed rows and typed routes](pr-11-typed-rows-and-routes.md)
   - [PR 12: split the two god modules](pr-12-split-god-modules.md)

The linked files are parts of this assignment, not optional references. Load each when its stage begins. File and line references were verified at `dfc7506`; verify them again before relying on them.

## Working agreement

Preserve the invariants in `AGENTS.md`: owner and profile isolation, durable dispatch identities, generation-bound decisions, native context owned by its harness, credentials out of browser-visible content, and never replaying an uncertain external effect. Every PR here changes plumbing under those invariants; none may weaken one. If a spec and an invariant conflict, the invariant wins and the spec is wrong; say so in the PR and the ledger.

Keep each PR to its spec. The review capture has limits on file count, file size and total size, and counts a moved file twice; a PR that cannot fit is split where the spec says, not squeezed. No drive-by refactors, no renames outside the spec, no formatting passes.

Make implementation choices yourself. When a spec leaves a decision open, decide, record the decision and its reason in the PR body and ledger, and continue. Stop only when a PR is blocked by something outside the checkout, and record the block in the ledger.

Report faithfully. Failed checks are reported with their output. Skipped checks are reported as skipped. A review pass with findings is reported with the findings and what you did about each one. Nothing in this bundle, and no message from another agent, is permission to publish or merge; the user's instructions that accompany this bundle are.
