# Implement native continuations in Loop

Implement this feature end to end in the Loop checkout you are given. Deliver tested production changes, independent reviewer findings resolved, and one commit containing your implementation. This is an implementation assignment; do not stop at a plan or a UI mock.

The motivating case is Heath, a Claude agent that finishes an answer while its native subagents continue. Its completed result correctly stays in Done. When the subagents return and Heath starts working again, Loop must create a new Working card in the same conversation without another user prompt. Support the same behavior across Loop's native harnesses, including Pi.

## Read progressively

1. Read the repository `AGENTS.md`, `README.md`, and [requirements](requirements.md). Establish the observable behavior and invariants before designing changes.
2. Read [implementation](implementation.md) and the linked production sources when working on persistence, session ownership, scheduling, and the Feed.
3. Read [harness adapters](harness-adapters.md) when implementing each protocol mapping. Verify supported versions and actual event contracts; the design notes are not a substitute for protocol evidence.
4. Read [validation and review](validation-and-review.md) before writing regressions and again before delivery. It defines the reviewer team, acceptance matrix, and single-commit handoff.

The linked files are parts of this assignment, not optional references. Load them when their stage begins rather than loading the entire repository. Existing contributor instructions and canonical product guides continue to apply.

## Working agreement

Inspect the checkout and preserve unrelated user work. Make reasonable implementation choices without repeatedly requesting confirmation. Trace every supported production execution path; avoid declaring a feature complete from one adapter fixture. Preserve harness-owned context, owner/profile isolation, generation-bound approvals, and durable dispatch identities. Never resend a prompt or replay an uncertain external effect to make a card appear.

Request review of the completed implementation and tests from the existing Loop review team through `loop_request_review`, as described in the review guide. Do not substitute independently spawned subagents for that team. Fix the team's findings, revalidate affected behavior, and obtain follow-up review of a fresh snapshot before delivery.

Report unsupported upstream behavior precisely, with evidence. Do not invent lifecycle events or silently claim full support. If an upstream limitation prevents a required acceptance case, identify it as unfinished work rather than marking the assignment complete.

This bundle describes proposed behavior. Update the existing canonical product documentation only after implementation; keep execution evidence and review results in the final handoff or PR, not as permanent product claims.
