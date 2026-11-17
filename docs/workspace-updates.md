# Workspace updates

How committed changes reach the Feed, open threads, sockets and integration clients. Each file below states its own rules in comments; timings, batching intervals and byte budgets live in the code.

| File | Owns |
| --- | --- |
| [changes.ts](../src/server/changes.ts) | The ordered change drain on each connection: committed-only reads, foreign-commit polling, subscriber delivery |
| [projected-database.ts](../src/server/projected-database.ts) | The synchronous write boundary; the Feed projector drains inside the outer transaction; transaction-control SQL is rejected |
| [feed-projector.ts](../src/server/feed-projector.ts) | Feed cards and Done unread flags |
| [queue.ts](../src/server/queue.ts) and [queue-machine.ts](../src/server/queue-machine.ts) | Run transitions and the hooks that run inside or after their transaction |
| [webhook-outbox.ts](../src/server/webhook-outbox.ts) and [webhooks.ts](../src/server/webhooks.ts) | Delivery records enqueued with the transition, backlog and leases |
| [worker.ts](../src/server/worker.ts), [worker-maintenance.ts](../src/server/worker-maintenance.ts), [run-lease.ts](../src/server/run-lease.ts) and [background-failure.ts](../src/server/background-failure.ts) | Scheduling wakes, maintenance timers, lease timing, sanitized failure reports |
| [run-signal.ts](../src/server/run-signal.ts) and [steering.ts](../src/server/steering.ts) | Per-run subscriptions; steering is claimed before delivery |
| [process-records.ts](../src/process-records.ts) | Process identity and workspace locks |
| [change-deadlines.ts](../src/server/change-deadlines.ts) | Approval and pull-watch expiry obligations and the next deadline |
| [server/workspace-events.ts](../src/server/workspace-events.ts) and [shared/workspace-events.ts](../src/shared/workspace-events.ts) | The v3 socket and the event contract, including payload budgets |
| [token-events.ts](../src/server/token-events.ts) | The integration-token event channel ([Integration API events](cards-api.md#event-pages-and-streaming)) |
| [done-thread-client.ts](../src/shared/done-thread-client.ts) | Saved Done paging and its membership-bound cursors |
| [client/workspace-events.ts](../src/client/workspace-events.ts) | Socket frames, the HTTP event poll and invalidations |
| [transcript-projection.ts](../src/shared/transcript-projection.ts) | The transcript reducer: revisions, chunk deduplication, gaps |
| [read-executor.ts](../src/client/read-executor.ts) and [CollectionRead.tsx](../src/client/CollectionRead.tsx) | Snapshot reads: cancellation, trailing-refresh coalescing, lifetime checks |
| [client/api.ts](../src/client/api.ts) | Read retries and Retry-After waits; writes are never retried |

Rules that span these files:

- Owner-scoped change-log cursors notify projections when committed data changes. The API observes the shared SQLite database, so updates from a separate worker are included.
- Integration tokens cannot open the browser event sockets; they use `/api/events/stream` and the HTTP event page. Integration-token HTTP responses omit the `X-Loop-*` clock headers that owner-session snapshots carry.
- Feed, conversation and Results snapshots read their body, revisions and watermark in one transaction. Browser pages require that watermark and replay events beyond it, so an older response cannot resurrect a deletion.
- Feed delta requests send bounded known-row signatures for their exact selection; the server rechecks authorized membership and ordering inside the snapshot transaction, and missing, oversized or mismatched known state falls back to a full page.
- `emit` checks that the requesting owner owns each subject; deletion producers capture ownership evidence before removing the row (see `db.ts`).
- Every v3 reset and events frame carries the source clock and next deadline. Approval refusal and watch visibility stay read-time predicates; expiry marks its obligation processed but never authorizes an external effect or invents a run transition.
- Every supported source runs the current build and reports complete invalidation coverage and delta delivery for transcripts, Feed and Results. Partial or snapshot-only sources from pre-release Loop builds are not supported.

Rules not yet stated in a single file:

- Webhook lease expirations add restart-safe notification obligations; processing them changes neither the lease nor delivery state.
- Deletions write their tombstones before cascades, and the durable change watermark survives event pruning.
- Unknown future event types and invalid rows invalidate every collection rather than being ignored.
