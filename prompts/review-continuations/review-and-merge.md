# Own delivery until every task PR is merged

The user explicitly authorizes opening PRs, communicating with the existing Loop reviewer team for this task, iterating on findings, and merging approved PRs to `main`. These are part of the assignment, not optional follow-up offers. Follow repository protections and obtain any genuinely missing external authorization without treating silence as approval.

## Review loop

1. Discover the available Loop review team through the workspace tools. Use `loop_request_review` and its advertised team IDs; do not invent IDs or substitute self-review or independently spawned agents for the Loop reviewer team.
2. Finish a coherent implementation and tests, commit the intended changes, run the required checks, and record the exact SHA. Request a branch snapshot review against the correct base. Preserve the returned review ID and snapshot identity. Keep the worktree stable during capture.
3. Retrieve the actual consolidated report with `loop_review_status`. A receipt, `running` state, timeout, or a lead that merely completed is not approval. Inspect each reviewer's state and the lead's disposition. If approval is ambiguous, ask the team explicitly to assess the submitted snapshot; do not infer approval from silence or missing findings after failed reviewers.
4. Address confirmed findings and explain any disagreement with evidence to the team. Make revisions, rerun checks on the new head, and request a fresh snapshot review. Repeat until the Loop team's consolidated verdict explicitly approves the final submitted content and no blocking findings remain. Earlier approval does not cover later changes.
5. Open/update the PR with the problem, resulting behavior, scope, validation evidence, limitations, and the review ID/snapshot-to-SHA mapping. Follow repository instructions about review before opening a PR. Link the consolidated approval evidence in the PR; do not fabricate a GitHub review or impersonate reviewers. If GitHub branch protection additionally requires a GitHub approval, obtain that too.
6. Immediately before merge, confirm the remote PR head is the reviewed/tested head, the base is `main`, required checks and approvals are satisfied, and no new blocking feedback exists. If base movement or conflict resolution changes reviewed content, revalidate and obtain fresh review. Merge using the repository's permitted method; preserve formatting commits when required by the development guide.
7. Verify through GitHub that the PR is actually merged and its resulting commit is on remote `main`. An accepted merge request or enabled auto-merge is insufficient. For multiple PRs, work in dependency order; retarget/rebase dependent branches after earlier merges, then test and review their final diffs again.

## Waiting while the installed Loop still has the bug

Do not depend on this unmerged fix to resume your own task. Maintain the review ID and keep orchestration alive while waiting. Use bounded waits with a modest backoff between status reads and provide periodic user updates. Do useful independent work where possible, but do not modify the submitted snapshot while claiming its review covers later changes.

Do not busy-loop, submit duplicate reviews to fetch results, or end with “review requested” and abandon the task. If a blocking request times out, recover the existing review by ID or the status tool's recent-request listing. If the team becomes unavailable or a review fails, investigate and recover through supported mechanisms; a replacement review must be an explicit new attempt with its reason recorded, not a blind retry of an uncertain request.

## Completion gate

Finish only when every PR created for this task has final-head Loop approval, required verification, and a confirmed merge to `main`, and the complete behavior in requirements.md is delivered. Report PR links, approved SHAs/review IDs, merge commits, checks and observed outcomes, and any live-validation limits. State explicitly that all task PRs are merged only after verifying it.

If permissions, infrastructure, or an unavailable reviewer block completion, preserve the ledger and report the exact blocker, current PR/review state, and next action. Do not bypass protections, invent approval, label unfinished work complete, or silently abandon a superseded open PR.
