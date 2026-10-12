# Status ledger

Update after every meaningful step. A fresh session must be able to resume from "Next step" alone.

| PR | State | Branch | PR URL | Next step |
| --- | --- | --- | --- | --- |
| 0 change stream | PR open | brief/00-change-stream | https://github.com/j-asefa/loop/pull/106 | Owner authorized merging PRs 0–4 after checks and Loop review. Recovered completed review c193cf2d for 543ce88 (all 3 reviewers) from Loop’s read-only review records. The native resolution/late transport failure race is fixed; typecheck, 963 tests (45 brief cases) and build pass. Push, request review, and merge #106 when confirmed findings are resolved. Then start PR 1 from main. |
| 1 schema and ledger | todo | | | |
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
- Handoff files are extracted to /tmp/loop-brief-handoff from the user attachment. This tracked STATUS.md is the current ledger. No later PR file has been opened.
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
- PR descriptions identify Codex as the authoring agent instead of the template's Claude Code attribution.

## Found, not fixed

None.
