# Deliver durable review continuations through merge

Implement reliable continuation after agent-requested Loop55 snapshot reviews. A coding agent must be able to request review, yield while it runs, receive its outcome, address findings, and finish the user's task without another user prompt. Deliver production changes, regression coverage, canonical documentation, and all task PRs approved by the existing Loop reviewer team and merged to `main`.

This assignment authorizes implementing changes, creating branches, pushing commits, opening/updating PRs, requesting and discussing reviews with the Loop reviewer team, and merging those PRs once the gates below pass. Do not stop at a plan, an open PR, a submitted review request, or an enabled auto-merge setting. Do not bypass repository protections or merge without approval. Preserve unrelated work.

## Read progressively

1. Read the repository `AGENTS.md`, `README.md`, and [requirements.md](requirements.md) before design.
2. Read [implementation.md](implementation.md) when tracing and changing the runtime. Load only the relevant canonical guides and source files it identifies.
3. Read [validation.md](validation.md) before writing regression tests and again before submitting each revision.
4. Read [review-and-merge.md](review-and-merge.md) before the first review request or PR. It governs all review iterations and final delivery, including how to wait while the currently installed Loop lacks this fix.

All four files are required parts of the assignment. Read them at their stage, not all source files up front. Keep a small local task ledger with branches, submitted SHAs, review IDs, findings, check results, PR URLs, and merge status so you can recover after context loss. Execution evidence belongs in PRs, not permanent product docs.

Use reasonable implementation judgment. Prefer one cohesive PR; split only when independently reviewable changes warrant it. Every PR created for this task must reach approval and merge to `main`. If an external blocker makes that impossible, report the precise remaining work and evidence; do not call the assignment complete.

The motivating report is that buffalo, a Claude agent, ends its run while review is pending. Source inspection identified a lifecycle gap, but did not establish buffalo's historical run-level cause. Do not present that diagnosis as verified live evidence.
