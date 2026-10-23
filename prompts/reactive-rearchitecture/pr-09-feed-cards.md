# PR 9: materialised feed cards

Depends on PR 6. Split into 9a (shadow projection) and 9b (switch). Keep the old query as a test oracle permanently.

## Goal

The Feed in `src/server/mobile-return.ts` is a string-templated SQL generator parameterised by four booleans feeding a CTE that branches on `@mode`, with three card identity schemes. Migration 081 moved halfway to a materialised projection with trigger-maintained `feed_*` columns recomputed by a fifteen-line statement repeated in every trigger. Finish the move with one row per card, maintained synchronously by application code, so the Feed read is an indexed select and the socket can ship the card.

## Inventory first

Build the inventory from the effective `sqlite_schema` after all migrations and from the readers, not from selected migration files. Triggers that matter include 081 and 084 feed state, 097 and 099 Cards invalidation, 103 terminal approvals and 105 Done-card invalidation; 096 only adds a column and 106 is a one-time repair. The Feed also reads native decisions, bookmarks, author and project context, queue positions, checkout and verification records, Later items and watch information. Folder moves and metadata changes can affect many conversations and both their old and new filter memberships. Put the inventory in the PR body.

## Model

- `feed_cards` has both thread rows and historical result rows, including idle cards (`d:idle:` in `src/server/done-cards.ts`), with the existing `run:` and `message:` identities so Done dismissals and client deduplication keep working. Working and Queued membership overlap; model membership as flags, not one bucket.
- `awaySummary` is run history since a timestamp, not the visible Feed; Social unread, Later due and scheduled-send counts are independent aggregates. Keep all of these separate unless the equivalence test shows a reason to combine.

## 9a: shadow projection

1. Table, indexes for every filter the current `feed()` supports, and a backfill migration.
2. A synchronous projector boundary, not an after-commit listener: `projectFeed(tx, affected)` is called by every writer inside its own transaction, after its writes, with the set of affected conversations deduplicated per transaction. Writers are every producer in the PR 6 inventory. It must not recompute every historical Done card on a streamed chunk; scope recomputation to the affected conversation's rows. Emission of `feed.card` events happens through `emit` in the same transaction and must not re-enter the projector.
3. Cheap invalidation triggers are allowed as a belt: a trigger that marks a conversation dirty is acceptable where a writer path is hard to reach. Dirty marks are drained by the projector before the writer's outer transaction commits, so the projection is applied-through at the same point as the event log; an unspecified later drain cannot share the log's watermark. If a later drain is ever needed, it must expose its own applied-through position to the socket.
4. **Expiry.** Invalidating and re-reading a materialised card does not change its stored membership, and expiries happen without a write. Store the expiry timestamps on the card row and keep the expiry-dependent predicates at read time, evaluated against the request's `now`; the PR 6 deadline wake then only triggers a re-read. Do not store a precomputed "expired" flag.
5. The equivalence test: run mutation sequences through production routes and compare the old `feed()` with the new read after each step, for items, order, cursors and summary counts. Sequences must include delete and move, folder subtree moves, owner changes, approval and watch expiry without a write, dismissal and undo, saved state changes, multiple results plus active work, queued-peer reorder, and crash or rollback mid-sequence.
6. The read path still serves the old query in 9a.

## 9b: switch

Serve `/api/feed`, `doneCardRows` and the summary counts from `feed_cards`; keep `awaySummary` on run history. Remove the expensive recompute triggers only when the equivalence test proves every writer, cascade, migration path and both processes maintain the table; keep cheap invalidation triggers if you chose them. Keep the HTTP contract identical except where the snapshot tests show a difference you have justified in the PR body. Keep the old query in test code as the oracle.

Move Later, scheduled sends, queue reordering, forking and outlines out of `mobile-return.ts` as pure moves only if the capture still fits; otherwise leave them for PR 12.

## Tests

The equivalence test stays in the suite permanently; `smoke:feed-events` and `smoke:design`; feed snapshot tests pass unchanged or with reviewed updates; performance evidence in the PR body for the Feed read's statement count and time before and after on a fixture with a few thousand conversations, and for write amplification during a streaming run.

## Acceptance

`feedSql` no longer exists in production code; the Feed read is a single indexed query; a run state change produces a `feed.card` event the PR 7 reducer applies; write amplification during streaming did not increase.
