# PR 7: projection deltas and timer removal

Depends on PR 6. Land it as a series of commits per surface; each surface's timer is removed in the commit that proves its coverage and only for sources that advertise the capability.

## Goal

With every change signalled, make the transcript and the Feed apply typed deltas in place, with a snapshot handoff that cannot lose or duplicate events, and remove the compensating timers surface by surface. The timers today: thread reload every 5 s, activity reload every 5 s, usage every 5 s, native decisions every 3 s, Feed every 30 s, App full refresh every 15 s, Results catch-up every 1.8 s, plus the per-frame full refresh in paired mode (`src/client/App.tsx` around line 1537).

## Design

1. **Real message identities.** Transcript deltas name the displayed message id, not the checkpoint id. The managed loop emits `message.upsert` for the round's public message written by `recordConversationUpdate`, with its content revision, and `message.delta` chunks against that id; the native flush emits `message.upsert` and `message.remove` for each item message it writes and for the aggregate, with revisions. The events carry the metadata the transcript projection uses to decide visibility of commentary versus the final answer. Native decisions get a complete `decision.*` lifecycle keyed by the server decision id, with the adapter request id as a field.

2. **Atomic batches.** The handoff below is only sound if an event's content has reached the projection row by the time the event is visible. Therefore: the batched message and projection writes and the `message.upsert` and `message.delta` events for that batch are committed in one transaction, then published through the bus; flush immediately at terminal, cancel and failure boundaries. Do not emit a chunk ahead of its materialisation. The current ordering at `agent-runtime.ts` around 964 to 972 (`saveTurn`, `persist(true)`, then `emit` per chunk) is replaced by one batched transaction at most every 250 ms per run, which also stops `saveTurn` and its transcript triggers running per chunk. The native path keeps its 1-second flush and now includes the delta text in the same transaction as its writes. If a future design ever commits raw chunks ahead of materialisation, snapshots need a projection-specific applied-through position; do not do that here.

3. **Consistent snapshot.** Every snapshot response (conversation page, feed page, results page) is read in one SQLite read transaction that returns the body, the per-entity revisions and the owner's watermark from PR 6 together. `GET /conversations/:id` in `core-routes.ts` currently combines several reads without an enclosing transaction; wrap them. A watermark read after the body can be newer than the body, and the client would then discard the event it needs.

4. **Client handoff.** Subscribe before fetching. Buffer events per request, keyed by source, owner and epoch; reject responses and buffers from obsolete request generations. Install the snapshot, then replay buffered events with id above the snapshot watermark, applying only those whose entity revision is above the snapshot's revision for that entity. A page watermark governs that page's handoff only, not other retained pages or collections. Bound the buffer; on overflow or on a reset frame, discard and resnapshot.

5. **Chunk identity, not revision alone.** Dropping lower revisions is not append deduplication: replaying a chunk at the same revision turns AB into ABB. Every `message.delta` carries the event id, a chunk index within the event, and the base revision or byte offset it applies to. The reducer applies a chunk only when its base matches the current state, ignores duplicates by (event id, chunk index), and on a gap or out-of-order chunk requests the message by `invalidate`. An event split across frames does not advance the reconnect cursor past its id until every chunk is applied; the cursor is therefore `(event id, chunk index)` or the client holds the cursor at the previous id until the event completes.

6. **No truncation.** An append delta that exceeds the wire budget is split into ordered bounded chunks with the identity above; if that is impossible, the server sends an `invalidate` for the message and the client refetches. The reconstructed message equals the stored one byte for byte; test it.

7. **Bounded drains.** Where one notification can represent several pages, the client drains while the response says `more`, bounded, instead of fetching once. This replaces the 1.8-second Results catch-up responsibility; keep that timer until this drain is in and tested.

8. **Capability negotiation.** A PR 7 client can connect to a linked source deployed at PR 3 or PR 5: it speaks v3 but its invalidations are incomplete and it has no deadlines. The reset frame from PR 3 advertises per-source capabilities (`invalidations: partial | complete`, `deadlines`, and per surface `transcript`, `feed`, `results`: `snapshot | delta`). Each fallback timer is removed only for sources that advertise the capability it depended on, and restored per source otherwise. Test legacy v2, early v3 and complete v3 sources together in one client.

9. **Per-surface timer removal.** For each timer: list the responsibilities it carries, cite the PR 6 inventory rows or the deadline wake that now covers each, add the coverage test, remove the timer in that commit, gated per source as in item 8. Keep: visibility, online and pageshow wake handlers; the HTTP fallback poll that runs only while the socket is down; explicit user refresh actions; the single deadline wake.

10. **Reducer in `src/shared`.** The client reducer and the server projection are tested against the same event sequences, as `src/agent-activities.ts` does.

## Constraints

- Payloads are display data; the client never acts on them as authority.
- Cross-source: reducers and buffers are keyed by source id.

## Tests

Production-boundary cases for the three handoff failures the reviewer probed in isolation: separate body and watermark reads lose an event; an event committed ahead of its projection loses it; atomic batch plus atomic snapshot yields the full content. Plus: reducer equivalence over recorded sequences including duplicate delivery, late fetch completion after a newer snapshot, reconnect, source replacement, owner change and legacy v2; disconnect halfway through a split event; duplicate chunks; a gap in chunks; chunked reconstruction equals stored content; per-timer coverage tests; mixed-capability sources; `smoke:feed-events` gains a case asserting near-zero requests between frames during a streaming run; `smoke:history` passes.

## Acceptance

A streaming reply renders token by token without a transcript fetch; the only client timers left are the socket-down fallback and the deadline wake, per source that advertises the capability; every removed timer has a coverage test naming what replaced it.
