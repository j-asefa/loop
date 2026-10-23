# Process: branches, pull requests, review loop, merge, ledger

Follow this for every PR in the bundle. It encodes how this repository's review team actually behaves, verified against `src/server/code-reviews.ts`, `src/server/review-snapshot.ts` and `src/shared/team-presets.ts`; do not improvise around it.

## Start a PR

1. `git fetch origin main`. Base every branch on `origin/main`, never on the local `main` of an agent worktree, which is stale.
2. Branch name: `reactive/NN-slug`, for example `reactive/02-change-bus`. Split PRs use `reactive/08a-worker-boundary`.
3. Set the ledger row to `in progress` with the branch name before writing code.
4. Read only that PR's spec. Verify every file and line reference against the checkout before relying on it.

## Implement

- Commit in small, buildable steps with clear subjects. Every commit message ends with the attribution line given in your session's system instructions.
- Add regressions at the production boundary you change, as [verification](verification.md) describes. A PR with no test at the changed boundary is not ready for review.
- Update canonical docs in `docs/` for lasting behavior changes only. Execution evidence belongs in the PR body.
- Stay inside the review capture limits before requesting review (`src/server/review-snapshot.ts`): at most 100 changed files, no single file over 512 KB, total under 16 MB, at most 2,000 repository entries in the capture, a unified diff command bounded at 300 KB, and diffs taken with `--no-renames`, so a moved file counts as a deletion plus an addition. `git diff --stat --no-renames origin/main` is a human scope summary of changed files and lines; it does not measure the blob byte sizes, tree entries or captured context the snapshot checks. For the actual limits, run a preflight that uses the capture logic in `review-snapshot.ts`, or check blob bytes and tree entries directly, and measure the diff with the capture's own options against its compare commits: `git diff --no-ext-diff --no-textconv --no-renames --unified=3 origin/main | wc -c` is a conservative check, not an exact capture measurement. If a spec cannot fit, split as the spec directs, add ledger rows, and land them in order.

## Verify

Run the checks the verification guide lists for the PR's category. Record each command, the date, and the outcome in the PR body. A failure you cannot fix is a block, recorded in the ledger; it is never described as passing.

## Open the pull request

```sh
git push -u origin reactive/NN-slug
gh pr create --base main --title "<imperative subject>" --body-file /tmp/pr-body.md
```

The body contains: what changed and why; the decisions you made where the spec left room; the checks you ran with dates and results; and a review section you append to after each pass. End the body with the pull-request attribution line from your session's system instructions.

## Review loop

The review team is the Loop "Review code changes" team, id `75e334bb-e16b-4d61-b16a-c6859d2337ad`, reached through `loop_request_review` with `scope: "branch"` and `base: "origin/main"`.

- **Request a review only on a commit whose checks are green.** Before calling the tool, record the branch head hash in the ledger's review history as the reviewed head.
- **Do not issue a new tool call merely to poll.** Each model-issued call has a new call id and starts a new review; the first time someone retried, six duplicates ran. The tool waits for the consolidated report, which can take several minutes, and may time out before the team finishes. If it does, do not call again. Record the review id, fingerprint and the lead's `conversationId` from the review report. To check progress, call the authenticated status route `GET /api/reviews/conversation/:id` with that lead conversation id (not your own conversation); it derives the review from that conversation's latest run, so verify the returned review id and fingerprint match the review you requested, and if they do not, read `code_reviews` by the exact review id instead. Never read "the newest row": it can belong to another PR, another conversation or another owner.
- **Wait in the foreground.** Background subagents, background shell tasks and pollers die when your turn ends, and nothing resumes you when they finish. Use a bounded `until` loop within the shell timeout and re-arm it. Never end your turn while a review is the only thing that will move the work forward.
- **The team does not emit approval.** Its preset forbids the lead from claiming approval; it does not require a finding on every pass. Treat the report literally: findings are findings, and an empty findings list with complete coverage is a clean pass.

**Gate.** Merge only when all of the following hold for the final code on the branch:

1. The latest pass reports no unresolved P0, P1 or security finding.
2. Every reviewer completed; the lead's own completion does not prove this. A failed, cancelled or interrupted reviewer is missing coverage, and the pass does not count.
3. The reviewed head is the branch head, except for commits that touch only `prompts/reactive-rearchitecture/STATUS.md`. Any other commit after the reviewed head, including any rebase onto a new base, requires checks and a fresh review: dependencies can change behaviour even when the patch did not. Record the reviewed base and fingerprint alongside the head.
4. Remaining P2 findings are fixed, in which case rule 3 applies, or documented in the PR body with the reason they are acceptable.

A disputed P1 or security finding is resolved with code evidence in the PR body. If the next pass repeats it, it stays blocking; never downgrade it to P2 by repetition.

**Cap.** After six passes on one PR with a blocking finding still open, stop, set the ledger row to `blocked` with the finding and your evidence, and move on to the next PR that does not depend on it. The cap is an escalation limit, never permission to merge.

After each pass, append one line to the ledger's review history and one entry to the PR body's review section: pass number, reviewed head, review id, counts, reviewer coverage, what was fixed.

## Merge

When the gate holds:

```sh
git fetch origin main
git rebase origin/main          # if main moved, the new head needs checks and a fresh review even if your patch is unchanged
gh pr merge <number> --squash --delete-branch --match-head-commit <reviewed-or-ledger-only-head>
```

Squash merges are this repository's convention. `--match-head-commit` pins the merge to the head you reviewed, so a push in between cannot merge unreviewed code. After merging, `git fetch origin main`, set the ledger row to `merged` with the date and merge commit, and start the next PR from fresh `origin/main`.

If a rebase conflicts with a merged earlier PR of this bundle, resolve in favour of the merged code's contracts and note it in the ledger.

## Ledger discipline

`STATUS.md` in this directory is the single source of truth for progress. Update it when a PR starts, after checks pass, before every review request, after every review pass, on merge, and on any block. Commit ledger updates on the PR branch so they merge with it. A reader who sees only the ledger must be able to continue.

## End state

Every row in the ledger is `merged`, or `blocked` with a concrete external reason the user must resolve. `origin/main` builds, `npm run test:all` passes on it, and the final report lists each PR with its merge commit, the number of review passes, and any documented P2s.
