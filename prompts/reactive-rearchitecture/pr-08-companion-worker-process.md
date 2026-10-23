# PR 8: companion worker in its own process

Depends on PR 4. Split by boundary work (8a) and process activation (8b), not by file count. Addresses the slow thread open on the laptop profile directly.

## Goal

In companion mode `src/workspace-host.ts` starts the worker inside the HTTP process (around line 197), and better-sqlite3 is synchronous, so every worker write blocks every phone request. The server profile already runs the worker separately; make the companion profile do the same, with native execution in the worker, behind an extracted ownership boundary.

## Measure first

Measure externally: a client-side timer around real requests to `/api/conversations/:id` during a streaming native fixture turn, plus `monitorEventLoopDelay` in the HTTP process reported in the authenticated `/api/build` payload and `loop logs`. A timestamp taken in a JS request callback cannot measure time spent waiting for a blocked loop, so it is not the before measurement. Record before and after in the PR body. Note that a child process does not remove SQLite writer contention or synchronous work that remains in API handlers; report those separately if they show up.

## 8a: extract the execution authority

Inventory everything the API side calls into in-process execution state. It is wider than `nativeSessions.*`: live controls, catalogs and settings; decision answers; enablement and Pi trust and package operations; the native tool bridge's tickets and generation checks; `nativeSignIns`; and the harness upgrade reservation. Pure database or filesystem helpers such as registrations, directory and project reads need not cross the boundary.

The concrete hidden race: `src/server/companion-routes.ts` reserves `harnessUpgrades` in memory before checking active runs (around line 189), and the worker's claim filter and native execute check the same in-memory object. With execution in a child, the API would hold a reservation the child cannot see and a harness could start mid-upgrade. Reservation, claim and launch must live under one execution authority, or the reservation must become a durable cross-process protocol. Choose the former: the worker owns upgrades, sign-ins, sessions, the tool bridge and claims; the API asks it.

Define the boundary as a module with explicit typed requests and responses, bounded message sizes, request ids, a worker generation, readiness and disconnect semantics, with zod schemas in one file. Retried decisions, settings changes and enablement carry durable command identities and never replay an uncertain external effect. The native tool bridge stays with the supervisor: its `current()` returns live session objects and enforces generation identity, which are not values to serialise; the API asks for controls, catalogs and actions by id.

In 8a the boundary is called in-process. All routes go through it; no behaviour change; the full companion suite passes.

## 8b: activate the child

- The host spawns the worker as a child with inherited Node IPC (simpler than another listening socket for a parent-owned child) and the same data directory and profile. Supervise it: restart on crash with backoff, stop on `loop stop`, respect `loop restart`'s refusal while runs are active.
- Exactly one supervisor, with takeover semantics. `nativeSessions.recover()` globally interrupts native runs and clears session generations, so a second worker starting by accident destroys the first one's sessions, and an expiring lease is not proof its holder stopped: worker A can pause, miss heartbeats, and resume after B has run `recover()`. Do not merely remove the companion guard in `src/server/worker.ts`, and never implement "lease expired, therefore recover and launch". Use a process-lifetime ownership lock held by the parent-owned child (an exclusive lock on a file under the data directory that the OS releases on process death), and allow takeover only after the prior supervisor and its detached children are confirmed stopped. Fence every claim and control request with the worker generation so a resumed stale holder is rejected at the boundary. Unknown external outcomes are preserved across a takeover, never replayed.
- Some adapters spawn detached children (`src/adapters/opencode.ts` around line 172, `src/adapters/acp.ts` around line 135). "Children die with the worker" is not automatic; implement and test cleanup on worker crash and on parent crash.
- The change bus from PR 2 already carries worker commits to the API through `data_version`.

## Constraints

- Worker ownership and device authorization stay as `docs/architecture.md` describes; update that doc and `docs/pairing.md`.
- `loop restart` and `loop upgrade` keep their address and paired phone; the package smoke proves it.

## Tests

- 8a: the companion suite unchanged; a test that an upgrade reservation blocks a claim through the boundary.
- 8b: refusal of a second worker while the lock is held; a paused-but-live holder A: B's takeover attempt is refused, B never calls `recover()`, A's generation is not revoked, and A remains the valid owner when it resumes; separately, after a legitimate replacement with A and its detached children confirmed stopped, A's stale generation is rejected at claim and control boundaries; worker crash and restart with owned runs interrupted, not replayed; parent crash cleans up native children; stale control responses rejected by generation; decision-answer transport loss leaves the decision unknown, never answered twice; `smoke:companion` both engines; `smoke:package`; the CLI daemon and connection tests.
- The external latency measurement from above, asserted as a bounded p95 in a regression.

## Acceptance

The HTTP process shows no event-loop stalls attributable to run writes during a streaming fixture; one worker holds the ownership lock; all listed smokes pass; the docs describe the two-process companion.
