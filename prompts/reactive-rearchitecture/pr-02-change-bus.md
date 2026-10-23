# PR 2: the ordered change bus

Depends on PR 1.

## Goal

Give each process one ordered way to learn that something committed. Today `emit` in `src/server/db.ts` is a bare INSERT into `events`, so every consumer runs a timer against SQLite: the socket at `src/server/workspace-events.ts` polls every 250 ms per connected socket, and the worker's scheduling interval runs the full claim query every 100 ms on the companion profile. After this PR a commit wakes one ordered drain per process, a foreign-process commit wakes the same drain, and the frames the browser receives are unchanged.

## Design

**One drain, two wake sources.** Add `src/server/changes.ts` with a single non-reentrant, coalesced drain per process. The drain runs outside any transaction, selects committed `events` rows with `id` greater than the process cursor in ascending id order, partitions them by owner, notifies subscribers, and advances the cursor only through rows it actually read. It drains bounded pages repeatedly until caught up, yielding between pages, so a backlog never waits for another commit. Nothing else advances the cursor; in particular an INSERT's `lastInsertRowid` never does.

Two things wake the drain:

1. **Local emit.** `emit` inserts the row and sets a dirty flag, scheduling the drain on the next macrotask. Under this repository's synchronous transaction convention the drain therefore runs after the enclosing transaction has returned. The database, not an in-memory queue, decides which rows survived: a row written inside an inner savepoint that was rolled back and caught by the outer transaction never appears in the read. Do not implement an in-memory payload queue keyed on outer-transaction success; it publishes rolled-back inner rows. If you also wrap `db.transaction`, preserve all four invocation variants and use the wrapper only to wake the same drain.
2. **Foreign commits.** One poller per process reads `PRAGMA data_version` on the same connection every 250 ms (configurable) and wakes the drain when it changes. Own-connection commits do not change it. Treat it as a wake hint, never a sequence. Sample the value before the drain or recheck after it, so a foreign commit in the sample-to-read gap is never absorbed into the baseline without being read.

The ordering hazard this prevents, reproduced by the reviewer with two WAL connections: the worker commits event 101, the API commits 102 and publishes it directly, advancing to 102, then the foreign read asks for ids above 102 and 101 is lost. SQLite serialises writers, so a lower id is committed before a later writer commits; one ascending read delivers both.

**Subscribers.** A subscriber receives its owner's events in id order. A subscriber that throws must not make the committed mutation appear to have failed and must not stop delivery to others. A subscriber that writes schedules a later drain; it cannot cause later rows to be published ahead of earlier ones because only the drain publishes.

**Socket.** `connectWorkspaceEvents` subscribes to the owner's publications and sends its existing v2 frame when notified. A reconnecting socket keeps its own durable replay cursor from the query string and performs its initial catch-up read, independent of the process cursor. Preserve every bound: byte budgets, reset on overflow, epoch handling, `bufferedAmount` close, session recheck. The Cards and Done revision watermarks have no event until PR 6; read them from one shared 5-second check per process that notifies the owner's sockets, not a per-socket poll. The frame format does not change.

**Worker wake.** The scheduling tick subscribes to `queued`, `running`, terminal and `queue.*` publications and runs `tick` on wake, coalesced, with a 2-second fallback. Also wake it when an execution slot is released: the terminal event is published before `active--` runs in the worker's `finally`, so an event-only wake can leave queued work waiting for the fallback. `recoverStale` runs inside `tick` today; leave it there. Maintenance timers are unchanged; those that have an event move in PR 4.

**HTTP fallback** at `/api/events` is unchanged.

## Tests

- Foreign 101 then local 102 before the poll: both delivered, in order, to the right owners.
- Caught inner-savepoint rollback followed by outer commit: the inner row is never published. Failed outer commit: nothing is published.
- Throwing subscriber and reentrant subscriber: the mutation succeeds; other subscribers receive the row; order holds.
- Subscription during catch-up; multiple replay pages with no later write; cursor never skips.
- Worker: enqueue wakes a claim well under the fallback; all slots full when a terminal event arrives still claims promptly; with the emitter disabled the fallback still claims.
- `test/event-sockets.test.ts`: two sockets for one owner receive the frame; another owner receives nothing; many connect and disconnect cycles leak no subscriptions.
- `smoke:feed-events` passes unchanged.

## Acceptance

No per-socket `setInterval` in `workspace-events.ts`; the worker's scheduling interval is a fallback; the ordering tests above are in the suite; all baseline checks and `smoke:feed-events` pass.
