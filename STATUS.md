# Status ledger

Update after every meaningful step. A fresh session must be able to resume from "Next step" alone.

| PR | State | Branch | PR URL | Next step |
| --- | --- | --- | --- | --- |
| 0 change stream | merged | brief/00-change-stream | https://github.com/j-asefa/loop/pull/106 | Merged as 8a4084c after typecheck, 963 tests, build and Loop review de341b77 (all 3 reviewers, no confirmed introduced bugs). |
| 1 schema and ledger | merged | brief/01-schema-and-ledger | https://github.com/j-asefa/loop/pull/109 | Merged as b466299 after typecheck, 1007 tests, build and three completed Loop reviews with findings addressed. |
| 2 generation job | merged | brief/02-generation-job | https://github.com/j-asefa/loop/pull/114 | Merged as b09b4e5 after typecheck, 1047 tests, build and completed Loop review 89a9f8df with confirmed findings fixed. |
| 3 api and project page | PR open | brief/03-api-and-project-page | https://github.com/j-asefa/loop/pull/115 | Checks green: typecheck, 1108 tests / 145 files (202.74s, one worker), build (1.49s), full smoke:design (363.8s plus approval layouts, both engines). Updated 390px screenshots. Completed Loop reviews 1479ed39 and 8c1e878a, all confirmed findings fixed. Main a211ca4 integrated. Push final validation commit, update PR, merge exact head, then start PR 4 from main. |
| 4 agent read tool | todo | | | |
| 5 feed card | not requested | | | Only on explicit instruction from the owner |
| 6 saved routing | not requested | | | Only on explicit instruction from the owner |

States: todo, in progress, checks green, PR open, merged, blocked.

## Blocked

(none)

## Decisions made during implementation

- PR 0 uses migration 077: main already contains migrations 073–076. The branch starts at origin/main 82182da.
- Handoff files are extracted to /tmp/loop-brief-handoff from the user attachment. This tracked STATUS.md is the current ledger. PR 3 is in progress; PRs 4–6 have not been read.
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

- PR 2 uses migration 079. The change-stream SQL trigger schedules publications/saves/removals that bypass recordChange; the helper also calls markDue. A generation lease and shutdown signal fence late completions and recover read-only provider work after crashes.
- Retry validation runs inside an outer transaction and rolls back a first attempt with errors before invoking the model again. Failed attempts use negative internal diagnostic versions and separate failure keys so they never reserve an owner-visible publication number or block a corrected pass.
- Initial input includes saved history, the newest 40 results and accompanying newer events; older skipped work is marked explicitly. Mail uses its actual delivered msg_ reference, because mail_ is outside the normative Cite union. Native decision citations expose the recorded request and state; the harness-owned answer is not available and resolved alone cannot supply approval evidence. INDEX entries include citation refs so overflow items remain usable under prompt rule 1.

## Found, not fixed

None.

- The generation event budget includes headers and cut markers, truncates UTF-8 without splitting characters, and makes progress past a single oversized event. Shutdown reschedules interrupted read-only work; a deadline records a failed attempt without an automatic retry loop.

- Review 89a9f8df fixes retain the initial skip boundary across saved-heavy passes, persist cursor metadata independently of publication, start each lease when its project begins, and recheck settings/token before each provider request. The report’s partial-output rejection suggestion conflicts with normative 03-schema per-rule recovery (only parse failure or every item failing is a failed attempt); preserve that behavior and cover mixed valid/invalid second output explicitly. The proposed unchanged-first-pass reproduction actually fails validation and stores a failed row; the regression instead verifies a real unchanged later pass.

- PR 3 goal edits bump the owner revision and append brief_edit without consuming a content version, preserving first-generation eligibility. Item edits/decisions publish owner versions with separate owner revision keys. Owner-created decisions may cite a saved res_ directly; subsequent model validation accepts that evidence only for an existing owner-authored item while the result remains saved.
- Agent creation used inline native selects rather than a reusable picker. Extract those unchanged selects into ConnectionPicker/ModelPicker and share them with Brief settings. Navigation retains the existing conversation/message parameters and workspace source; source metadata is owner-scoped, without connection secrets.

- The handoff’s existing-test preservation rule is retained for product regressions. One existing design helper needed a selector repair: main already selects a hidden Needs-you card after clicking Done. The one-line .inbox-results scope restores its intended journey and leaves all keyboard assertions intact; baseline reproduction is recorded in /tmp/brief3-baseline-design.log and the PR.

- The same isolated main also fails create-agent-layout (legacy environment naming fixture) and core (scrolling after the body is frozen). Name the fixture through bootstrap, and scroll before opening settings; retain keyboard/layout assertions and check the frozen body position during wheel gestures. These are browser harness repairs, with no production Feed/Thread/history changes. Evidence: /tmp/brief3-baseline-more.log.

- Existing core/profile and continuity browser expectations also lag main: Files is already the fifth profile tab, and Needs you is already a stack opened with Show all. Repair those selectors/expectations without changing their behavioral assertions. The main MyProfile/Inbox components prove these pre-existing surfaces.

- Loop review 1479ed39 completed with all three reviewers. Fixes retain the full fresh brief in the parent and reload on mount, send failed drafts to existing workspace-aware Scheduled URLs, detect initial generation from the incorporation cursor, and expose recorded content from the disabled setup screen without restarting generation. New unit/browser regressions cover these cases.
- Existing live-message fixture used run_traces, but production now owns progress in messages/update_key. Update that fixture to durable identities and retain streaming, scroll, reply-target, deduplication and reload assertions. Both engines pass. Existing swipe fixture needs consistent pageTop/offsetTop and a title-based reading position to accommodate current card heights; both engines pass. No production Feed, Threads or history behavior changed.

- Main advanced to a211ca4 with the parallel Feed PRs (080–082 migrations). Merge conflict resolved by keeping main's private nextAction(FeedRow) and adding message targets to the existing briefAttention boundary; the Brief page reads those targets.
- The baseline WebKit home-scroll failure required one additional animation frame for the selected Feed layout to settle before smooth scrolling. Profile checks keep all assertions and use consistent headless viewport coordinates plus a single double-click action within the 350 ms window. This preserves the existing home behavior; no other Feed behavior changes.

- Review 8c1e878a completed with all three reviewers and one confirmed finding. The full ledger now paginates by immutable first_version/id; editing an unseen item cannot move it behind the cursor. The route regression edits both an unseen and already-seen row between pages and verifies 55 unique items.
- A real tab-reopening browser regression caught a duplicate acknowledgement after an edit. The parent retains acknowledgement receipts per owner/project across child mounts; the rendered view still refreshes from the server and a failed acknowledgement remains retryable.

- After Feed integration, the workspace controls browser fixture also needs its loaded-page selector scoped to visible Done results. Badge counts and all model/upload assertions remain intact.
