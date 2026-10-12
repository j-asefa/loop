# Status ledger

Update after every meaningful step. A fresh session must be able to resume from "Next step" alone.

| PR | State | Branch | PR URL | Next step |
| --- | --- | --- | --- | --- |
| 0 change stream | merged | brief/00-change-stream | https://github.com/j-asefa/loop/pull/106 | Merged as 8a4084c after typecheck, 963 tests, build and Loop review de341b77 (all 3 reviewers, no confirmed introduced bugs). |
| 1 schema and ledger | PR open | brief/01-schema-and-ledger | https://github.com/j-asefa/loop/pull/109 | Started from main 8a4084c. Migration 078, bounded schemas, citation resolution, transactional apply and live serving are implemented. Initial checks passed (995 tests). All seven findings in completed Loop review 8c69dfbc are addressed; 38 focused regressions pass. Review 05850503 completed with three further findings, now addressed: durable PR scope, omitted existing evidence and owner question attribution. All findings from three completed Loop reviews (latest a5e77daf) are addressed. Forty-four focused tests and typecheck pass. Final full suite/build are pending; record results, merge PR 109, then start PR 2 from main. |
| 2 generation job | todo | | | |
| 3 api and project page | todo | | | |
| 4 agent read tool | todo | | | |
| 5 feed card | not requested | | | Only on explicit instruction from the owner |
| 6 saved routing | not requested | | | Only on explicit instruction from the owner |

States: todo, in progress, checks green, PR open, merged, blocked.

## Blocked

(none)

## Decisions made during implementation

- PR 0 uses migration 077: main already contains migrations 073–076. The branch starts at origin/main 82182da.
- Handoff files are extracted to /tmp/loop-brief-handoff from the user attachment. This tracked STATUS.md is the current ledger. PR 1 instructions are now open; PRs 2–6 have not been read.
- Owned child folders resolve to the nearest project, preserving every kind=project row as required by decision 2 (including nested projects); standalone artifacts fall back to their own folder_id. Both choices address confirmed review findings.
- An SQL view shares owner/project validation between backfill, publication/deletion triggers and application writers. Record-specific fallback uses that record's run, never a newer run in the conversation.
- Historical resolved approvals use created_at because approvals retain no decision timestamp. New decisions record the current time.
- Live steering, direct result-card saves, approval dismissal/recovery, native expiry/unknown outcomes and confirmed PR merge/closure observations also advance the cursor. These are existing paths for the specified kinds.
- PR update refs encode watch id, event kind and item identity. Mail requeues record the second accepted delivery; submission retries remain idempotent.
- Fixture HTTP listeners need execution outside the filesystem/network sandbox (loopback listen returns EPERM inside it). No live provider is used by the regressions.
- Ordinary folder reparenting records departing citations and the destination project’s current records atomically; nested projects retain their own identity.
- Artifact filing and undo append a tombstone to the previous project and publication/save events to the destination when effective project scope changes; conversation/run scope still wins.
- Native decisions now receive created/resolved upgrade history, using created_at where no historical resolution time exists.
- Archived rows remain in historical publication/save events, as PR 0 explicitly specifies one row per publication/pin and no historical tombstone backfill. The cursor is an append-only record of changes, not a visible-items projection. Consumers must resolve current source state (standing decision 3); archived sources stay excluded from the unchanged artifact/Saved readers.
- Unarchiving restores publication/save events. Conversation project assignment records earlier newly scoped history and removes prior scope where applicable. Prompt and published-artifact edits advance the cursor so changed quoted text can be revalidated; running placeholders still wait for publication.
- Each physical bookmark/pin transition is recorded, including removal of a message bookmark after its result appears. Live results use publication time; historical result backfill retains artifact created_at exactly as the handoff requires.
- A later run's different folder does not override the conversation project for brief scope. This follows PR 0's explicit conversation project, else run folder rule; existing Saved/Feed readers retain their own scope unchanged under decision 1. Review c7dac3aa proposed changing this precedence, which would conflict with the supplied contract; the regression covers the reported scenario.
- The owner authorized PRs 0–4 to be merged in order after checks and Loop review. A tool timeout is not a clean review: completed reports can be recovered read-only from this workspace’s owner-scoped code_reviews/run records.
- A harness-confirmed native resolution wins over a late answer transport failure; the race emits one resolution and never replays the answer.
- Recovered review 59ab2dc0 proposed filtering tool artifacts from publication history, but PR 0 explicitly requires one result event per artifact_publications row. Keep the specified history. Tombstones for previously unannounced sources are harmless invalidations; consumers resolve current source state.
- PR 1 uses migration 078. Not-sent messages are stored in scheduled_sends; Later reminders have no delivery-failure state. Reuse the existing scheduled-send and Feed projections.
- PR review attention uses the latest matching stored PR card’s requested reviewers and the watch’s authenticated login/head; an open watch alone does not prove that the owner owes a review. No GitHub network call is made by the brief reader.
- Applied evidence requires a published result from a run started after the cited proposing result was published (the existing item’s result, or the first result cited on a new item). Overlapping runs do not count as later application.
- PR descriptions identify Codex as the authoring agent instead of the template's Claude Code attribution.

- Review fixes add cascading project references for cursor/ack rows, classify delegated/workflow child prompts by durable run provenance, preserve paused attention and normalize null optional fields.
- Durable PR event bindings are additive message metadata, populated by migration/backfill and a change-stream trigger. Rate-limit history can still be cleared on watch resume. Only recorded merge events count as merge evidence. Historical updates whose delivery mapping was already deleted cannot be reconstructed safely and remain unresolved.
- Oversized citation quotes retain an exact 300-character prefix; ellipsis is reserved for authored prose so quote containment stays valid.
- Existing item updates preserve omitted optional fields; empty text clears a rationale/blocker and explicit null clears a supersedes/answered-citation link. Change aggregation retains the latest operation and the earliest changed version since acknowledgement.

- PR watch citation scope uses explicit conversation filing or the event’s recorded project; live watch scope falls back to its latest recorded update, then creation-time run. Unrelated newer runs do not move old evidence.
- Omitting an existing decision’s evidence reuses and revalidates its recorded evidence, matching other retained fields. A decision with no recorded evidence still becomes a question; attribution follows a proposing result’s agent or an owner-authored message as appropriate.
- Review 05850503 did not confirm the proposed same-output foreign key failure: the model cannot reference fresh server-generated item ids.

- Review a5e77daf fixes preserve stale inherited answer citations and explicit reversals, validate an entire long quote before truncation, resolve both CI update event kinds, and restrict the PR-binding trigger to delivery runs (messages_run index verified). Native permission and paused-run attention refs are opaque source ids; consumers navigate the supplied conversation, not a guessed approval-table endpoint.

## Found, not fixed

None.
