# PR 3: typed invalidations on the socket

Depends on PR 2. This PR changes the transport and the type of what travels on it. It removes no timers and applies no deltas; PR 7 does that after PR 6 proves coverage.

## Why the split

Today's events are not a projection contract. The managed loop writes public turn messages through `recordConversationUpdate` keyed by round, but its `message.*` events name the checkpoint message id. The native flush upserts several per-item messages and emits only the checkpoint id. Native requests are `native.event` plus state transitions, with a server decision id that differs from the adapter request id. `activity.updated` is deliberately content-free. `feed.changed` means an artifact was hidden, `queued` can have an empty payload, and nothing is emitted for changes that happen without a write, such as approval expiry. A reducer built on these payloads reconstructs the wrong transcript. So this PR gives the stream types and explicit invalidation semantics first.

## Design

1. **Event union.** Create `src/shared/workspace-events.ts`: a zod discriminated union over every event type the server emits (`grep -rhoE 'emit\([^)]*"[a-z._:-]+"' src/server`). Each variant has a strict payload schema and size bounds, modelled on `src/agent-activities.ts`, and a `scope` describing what it invalidates: `{kind: "run" | "conversation" | "collection", id?}` where collection names are the client's pagers (feed, results, runs, approvals, decisions, activities, saved, later, scheduled). Change `emit` to accept the union, so an unknown type or malformed payload is a compile error and a runtime refusal.
2. **Historical rows.** Rows already in `events` may not satisfy the strict union. The socket serialises a row that fails validation as `{type: "invalidate", scope: {kind: "collection", id: "all"}}` rather than dropping it or crashing. A client that receives an unknown future type treats it the same way.
3. **Frame v3.** With `v=3` in the socket query the server sends `{v: 3, type: "events", epoch, cursor, events: [{id, event}]}` and `{v: 3, type: "reset", epoch, cursor, build, buildIdentity}` with the same reset semantics as v2. A watermark-only notification, which today is `events: []` with an unchanged cursor, becomes an explicit `invalidate` event for the affected collections; a v3 client must never receive a frame that carries no actionable content. Without `v=3` the server sends v2 unchanged, so cached PWA clients keep working.
4. **Oversize.** Keep the existing byte budgets. An event that does not fit is replaced on the wire by an `invalidate` for its scope; the durable row is untouched; nothing is truncated.
5. **Linked sources.** `src/linked-docker.ts` forwards only `epoch` and `cursor` on the proxied socket; forward `v` as well, and test v3 through the paired Docker proxy fixture, not only against the server directly.
6. **Capabilities.** The v3 reset frame carries a `capabilities` object for the source: `invalidations: "partial" | "complete"`, `deadlines: boolean`, and per surface `transcript`, `feed`, `results`: `"snapshot" | "delta"`. In this PR every source advertises `partial`, no deadlines, and `snapshot` everywhere. Later PRs raise them as they land, and the client removes a fallback only for a source that advertises the capability it replaced; a PR 7 client talking to a linked source still at PR 3 or PR 5 keeps its timers for that source. Linked sources advertise their own capabilities through the proxied socket.
7. **Client.** `watchWorkspaceEvents` requests v3, parses the union, and exposes `events` to callers. In this PR every caller maps events to the same `changed()` behaviour it has today, scoped by collection where the event names one, so a Feed-only invalidation no longer reloads the thread. Every existing timer stays.

## Tests

- Union round-trip for every emitted type, with a fixture of historical rows proving the `invalidate` fallback.
- Socket v3 against the compiled server and through the linked Docker proxy: typed frames parse; oversize becomes `invalidate`; v2 clients still receive v2; watermark-only changes produce an `invalidate`.
- Client: a collection-scoped event triggers only that pager's reload; capabilities parse from the reset frame and are exposed per source.
- `smoke:feed-events` passes.

## Acceptance

`emit` is typed; v3 frames carry parsed events with explicit scopes; no behaviour change is visible to the user; no timer was removed.
