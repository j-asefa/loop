# Investigation and implementation map

Read `docs/architecture.md` for runtime/persistence/source boundaries, `docs/workspace.md` for reviews and agent mail, and `docs/harnesses.md` for native turn behavior. Follow their links only as needed. Read `docs/development.md` before changing schema or selecting checks.

## Evidence to revalidate on current main

Commit `c292d4b2` (PR #208, “Make agent review results recoverable after tool timeouts”) introduced immediate receipts and recoverable status. It also made async review delegations background and excluded review children from ordinary mail delivery. The commit explains avoiding tool timeouts; it does not document a necessity for suppressing all completion notifications.

Starting points:

- `src/server/code-reviews.ts`: snapshot creation, requester provenance, background/foreground link, status/report projection.
- `src/server/review-access.ts`: request/status schemas and access boundaries.
- `src/server/native-tools.ts`: tool exposure, request invocation, and agent-facing guidance.
- `src/server/agent-mail.ts`: `sweepAgentMail`, `deliverResult`, routing, deduplication, and uncertain-delivery recovery.
- `src/server/agent-runtime.ts`, worker/queue callers, and per-table SQL modules: actual scheduling, completion, waiting, and restart recovery. Locate current callers rather than assuming names remain stable.
- `src/adapters/claude.ts`: native `result` completion and steering. Trace other supported execution paths; the durable workflow must not depend on a Claude-specific prompt trick.
- Feed/mobile projections and conversation rendering: inspect the production projection used for pending review work and resumed runs.
- `test/team-presets.test.ts`, agent-mail tests, native-tool/adapter fixtures, and production queue tests: reuse realistic boundaries.

Simply deleting the `reviewId IS NULL` filter is insufficient. The existing delivery sweep joins the parent's team; `deliverResult` requires team context and uses ordinary delegation wording. Review requesters may be outside the reviewer team and outside any team. Establish a narrowly authorized review-completion path that works for those requesters without widening ordinary mail permissions.

## Design before editing

Write a concise design in the task ledger: durable identity, eligibility, state transitions, transaction boundaries, delivery acknowledgment, restart recovery, cancellation races, snapshot freshness, and legacy-record policy. Choose whether to extend an existing primitive or add a review-specific one based on actual callers. Avoid a second independent retry engine if existing machinery can safely serve this case.

Trace the sequence from request receipt through lead completion, worker sweep, durable continuation creation, native dispatch, and observable Feed state. Account for completion before the original tool returns and completion concurrent with requester termination. Decide how explicit blocking calls and timeouts interact with notification delivery so users do not get duplicate reports or unnecessary follow-up runs.

Keep new domain SQL in per-table modules with lazy preparation and existing row schemas. Follow named migrations and existing API/event registries. Do not expand SQL allowances, source-boundary exemptions, or formatting ignores. Update canonical workspace/harness documentation and tool descriptions to explain automatic continuation, status recovery, and limits; link instead of duplicating explanations.

Do not restart or replace the user's live Loop instance merely to test the change. Use isolated fixtures or a documented isolated runtime. A fix in the checkout does not change the currently serving worker until that build is deployed.
