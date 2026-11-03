# Validation and review evidence

Read `docs/development.md`, especially manual verification. Verify commands against current `package.json`. Add regressions at production request, completion, scheduling, and dispatch boundaries, not only an isolated helper.

## Required regression matrix

| Scenario | Observable evidence |
| --- | --- |
| Async receipt, requester yields, review finishes | Pending obligation survives native completion; exactly one eligible continuation reaches the original conversation without a user prompt |
| Requester active or busy in another conversation | Correct steering/queue behavior; no overlapping native session or lost result |
| Requester outside every team | Review completion returns successfully without granting general team access |
| Another owner/profile/source/agent attempts access | Request, status, and completion delivery preserve isolation |
| Repeated sweep, concurrent workers, restart before/after recording delivery | Stable durable identity; no duplicate run or external delivery |
| Delivery disconnect/timeout after possible acceptance | Uncertain outcome retained; production recovery caller does not automatically resend |
| Cancellation races, paused/held requester, retired agent | No unwanted resurrection; pending work has an explicit disposition |
| Lead failure/interruption/cancellation or partial reviewer failure | Honest terminal outcome; no false approval, infinite wait, or duplicate review request |
| Blocking request, timeout, status recovery | Same review remains recoverable; no duplicate notification/continuation |
| Two reviews, newer edits, newer task or generation | Correct snapshot attribution and generation handling; stale review cannot authorize newer work |
| Existing records after upgrade | Documented eligibility policy; no historical notification flood |
| Feed/conversation lifecycle | Pending review is visible, original results preserved, resumed work appears correctly |

Exercise the Claude result-to-completion path with a deterministic adapter fixture, plus the shared scheduler path and materially different queued/live delivery capabilities. Cover API execution if it exposes this review tool. Inspect all relevant production consumers before claiming cross-harness support. Fixture results do not prove live provider compatibility.

Run focused tests while developing. For each submitted PR head, run `npm run check` and relevant suites/build/browser checks required by the touched boundaries. For the completed runtime change, run `npm run test:all` and `npm run build`; add the relevant Feed/browser smoke if presentation or event behavior changes. Use the documented resource limits and isolated fixtures. Fix failures; report unavailable checks as limitations, never passes.

Record submitted SHA, exact commands, observed exit codes, `check:` lines, review IDs, and remaining limits in each PR. Reviewers inspect snapshots and do not execute tests. Rerun checks after revisions; select additional focused checks based on the changed behavior. Do not claim live Claude, provider, device, or tunnel validation unless actually performed in an authorized environment.
