# Required behavior and scope

The primary scope is `loop_request_review` and the subsequent consolidated snapshot-review outcome. It is not generic polling of GitHub PR reviews or redesign of every background task. The implementation must work independently of which supported harness requested the review.

## Observable contract

- Keep the default request asynchronous: return a durable review ID promptly. Preserve status recovery across turns and optional blocking `wait: true` behavior without starting duplicate reviews.
- Persist the continuation obligation before returning the receipt. The workflow remains visibly pending while review is outstanding; a final native turn must not silently abandon it or imply that the user's whole task is done.
- A completed consolidated review automatically delivers its outcome to the requesting agent in the original conversation, using its existing harness-owned context. No user prompt is required. Do not wake the requester separately for each individual reviewer when the lead has not consolidated the report.
- If the requester is active, deliver through supported live steering or safely queue a follow-up. If it is idle, schedule a continuation. Avoid simultaneous native turns or a second conversation merely to deliver a result. Respect per-agent scheduling when it is busy elsewhere.
- Preserve finished turn results and history. Model the pending workflow and subsequent run explicitly; do not keep a dead Claude process falsely marked running. Choose a waiting representation consistent with existing run/Feed semantics and test the actual UI projection.
- Convey review ID, snapshot identity/scope, terminal outcome, consolidated report or recoverable report reference, reviewer failures, and limitations. Completion is not necessarily approval. Failed, interrupted, or cancelled reviews must produce an honest actionable outcome, not endless waiting or automatic resubmission.
- User cancellation must suppress unwanted continuation and retain existing cancellation propagation. Define behavior for paused/held runs, retired agents, removed teams, unavailable providers, and an explicitly cancelled requester. Do not silently unpause held work.
- Keep status reads available after delivery, tool timeout, restart, or later turns. They must remain read-only and must not produce another wake-up or snapshot.
- Avoid duplicate continuations under repeated sweeps, concurrent workers, crashes, and retries. Persist dispatch identity before external delivery; an uncertain harness delivery must not be automatically replayed. Expose uncertainty and supported recovery honestly.
- Prevent stale results from being presented as review of newer edits. Tie the outcome to its captured snapshot and original requester. Multiple review requests and later user tasks must not lose or misattribute results.

## Invariants

Preserve owner/profile/source isolation, generation-bound decisions, native context ownership, credential secrecy, and durable dispatch identities. A requester need not belong to the review team or any team. Review provenance authorizes the narrow return path; it must not grant general cross-team mail or review access.

Do not remove the async timeout fix, rely on model instructions alone, introduce unbounded polling, automatically retry uncertain external effects, or treat a requested/timed-out review as approval. Prefer existing delivery and queue primitives where their authorization and lifecycle semantics fit.

Document upgrade behavior for pre-existing pending and completed reviews: prevent a historical flood of unsolicited continuation runs. Define and test eligibility/cutoff or migration behavior explicitly.
