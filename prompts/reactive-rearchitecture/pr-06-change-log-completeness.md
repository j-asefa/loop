# PR 6: complete change signalling

Depends on PR 3 and on the minimal subject migration PR 4 lands. This is the coverage work PR 7 needs before any timer can go.

## Goal

Make the change log able to describe every change the UI currently discovers by refetching. Today saves, dismissals, Later, scheduled sends, Social reads, folder and team changes have no event and are discovered through the Cards revision tables or by timers; `src/server/activities.ts` borrows a run id as a signal; and some changes happen with no write at all, such as approval expiry and stopped-watch display expiry, which `src/server/cards.ts` tracks with a separate time cursor around line 485 and which the Feed predicates and approval selection in `src/server/mobile-return.ts` depend on.

## Design

1. **Subjects.** PR 4 already made `events.run_id` nullable, keeping its foreign key with `ON DELETE CASCADE`, and added `subject_kind` and `subject_id` with the `run` and `connection` kinds. This PR extends the kinds to: `run`, `conversation`, `message`, `artifact`, `approval`, `decision`, `later`, `scheduled_send`, `mail_thread`, `connection`, `agent`, `folder`, `team`, `social`, `collection`. Add the index on `(owner_id, subject_kind, subject_id, id)` and a check that run subjects carry the matching `run_id`. Owner and subject ownership are enforced in `emit` at the producer; for a deletion, the producer establishes ownership before the delete and passes it to `emit`, which must not require the subject row to still exist.
2. **Tombstones and the watermark.** Cascading a run's events away must not delete the only notification that the run or its card disappeared. Every delete that affects a projection emits, in the same transaction and before the cascade, a tombstone event with `run_id` null and a surviving subject: the conversation, or `collection` with the collection name when nothing else survives. The replay cursor is the event id, which is monotonic, but the highest id can itself be cascaded away; so maintain a durable per-owner `change_watermark(owner_id, last_event_id, epoch)` row updated in the same transaction as every emit, and have the socket derive bounds from it rather than from `max(id)` over `events`.
3. **Producers.** Every write the Feed, Results, Saved, Later, scheduled sends, approvals, decisions, activities, Social counts and the Pull requests tab depend on emits a typed event with the right subject and scope. Build the inventory from the effective schema and the readers: list the triggers in `sqlite_schema` after migrations (097 and 099 implement Cards invalidation, 103 changed terminal approvals, 105 Done-card invalidation) and the readers in `mobile-return.ts`, `cards.ts`, `done-cards.ts`, `results.ts`, `feed-predicates.ts` and `run-attention.ts`. Put the inventory in the PR body as a table of change, producer, event, scope. Remove the `signal` field from `ActivityScope`.
4. **Cards compatibility.** `feed_revisions` and `done_card_revisions` hold per-object changes and removals, scope and epoch identity and bounded revision progress, and Done adds a time cursor. Keep them as compatibility projections written in the same transaction as the emit, so `docs/cards-api.md` semantics and `cards:check` are unchanged. Do not replace them with the log in this PR.
5. **Deadline wakes.** Changes without a write need a protocol, not a single hint:
   - **Server scheduler.** On startup, seed from every durable expiry-bearing row (pending approvals, native decisions, watches), including overdue ones, and process them. After every create, change, delete or expiry of such a row, recompute the owner's next deadline and rearm. When a deadline passes, in one transaction: apply the expiry's durable consequence where one exists, emit `invalidate` for the affected collections, and emit `deadline` carrying the owner's new next deadline, or an explicit null. The second deadline is therefore advertised without any user write.
   - **Initialization.** Every v3 reset frame and every snapshot response carries `serverNow` and `nextDeadline` (nullable) for that owner and source, so a client that connects after creation, reconnects, or hits an epoch reset learns the deadline even though historical deadline events are not replayed (workspace-events resets to the latest cursor on a new or invalid epoch).
   - **Client.** One timer per source, keyed by owner, source and epoch, with a generation check so a late callback from a replaced timer is ignored. Replacing or deleting the earliest deadline replaces the timer. The timer fires an authoritative read for the affected collections; it never decides locally that something expired. Compute the delay from `nextDeadline - serverNow` at receipt, so client clock skew does not matter.
   - **Interaction with PR 9.** Invalidating and re-reading a materialised expired card does not change its stored membership. PR 9 must either keep expiry-dependent predicates at read time or have the deadline transaction recompute the affected cards before publishing; PR 9 chooses read-time predicates, and this PR must leave the expiry timestamps queryable for that.
6. **Socket.** With every change now signalled, the shared 5-second Cards check from PR 2 is removed, and watermark-only frames no longer exist.

## Tests

- Migration test; fresh and upgrade; cascade of a run's events leaves the tombstone and the watermark row survives.
- For every row of the inventory table: perform the change through its production route and assert the typed event with its subject and scope arrives on a v3 socket. The inventory table is the test list.
- Deadlines: connect after creation; two expiries with no intervening mutation; extend and delete the earliest; restart across an expiry; a client with a skewed clock; two sources with different deadlines; an overdue row at startup.
- Deletion ownership: an authorized delete emits its tombstone; an unauthorized one emits nothing.
- Cards reader tests and `cards:check` green.

## Acceptance

The inventory in the PR body has an event for every reader dependency; the PR 2 safety read is gone; no frame carries an empty event list; the deadline tests above are in the suite.
