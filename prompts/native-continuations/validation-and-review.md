# Validation and reviewer handoff

Read [development and verification](../../docs/development.md). Inspect `package.json` and the test runner before selecting commands. Add regressions at the changed production boundaries, using isolated databases and subprocess fixtures. Do not contact real providers from automated fixture tests.

## Acceptance matrix

| Scenario                                                        | Required assertion                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Completed A, background work, delayed parent start, completed B | A remains unchanged; exactly one B appears in Working and its own output becomes a normal completed result.           |
| Child progress, child result, or task notification only         | No parent continuation is created until parent execution is evidenced.                                                |
| Several children return while parent is active                  | One active parent run, correctly attributed output, no duplicate prompts or cards.                                    |
| Prompted start, Loop mail/delegation, steering, automatic retry | Existing run identities remain correct; no extra continuation from a normal start or internal cycle.                  |
| End/start events in the same transport burst                    | Prior cleanup cannot erase B or associate B's events with A.                                                          |
| Duplicate events, history replay, reconnect snapshot            | Stable identities prevent duplicate runs, output, terminal actions, and notifications.                                |
| Approval, question, live reply, cancellation during B           | Normal controls affect B; stale decisions and late terminals cannot affect its successor.                             |
| Queued user input races with autonomous start                   | One native execution at a time, no lost input, no automatic replay of uncertain delivery.                             |
| Background completion after the old idle deadline               | Session survives; actual parent resumption creates B. Test beyond 60 seconds using controlled time where appropriate. |
| Last child finishes before parent starts; capacity pressure     | No premature timeout or eviction in the gap; resource accounting remains correct.                                     |
| Unknown background state, including opaque Pi extension         | Chosen retention policy permits delayed wakeup and has tested cleanup/resource behavior.                              |
| Process exit, transport loss, application restart               | Verified reconciliation or visible interrupted/uncertain state; no blind redispatch.                                  |
| Wrong owner, conversation, native session, or generation        | Events and decisions cannot mutate another execution or expose its data.                                              |
| Several successive autonomous continuations                     | Each logical execution has its own run; buffers, flags, timers, and capabilities remain correct.                      |

Cover Claude and Pi through real adapter event ingestion into production session/run handling and Feed/transcript projections. Include shared lifecycle coverage for every mapped adapter and negative coverage for unsupported capabilities. Assert native prompt-write counts: adopted work sends zero additional prompts. Test database identities and observable API behavior, not just a helper or a mocked lifecycle reducer.

Useful starting fixtures include `test/adapters.node.test.ts`, `test/native-projection.test.ts`, `test/native-turn-recovery.test.ts`, `test/native-auto-approval.test.ts`, `test/mobile-return.test.ts`, `test/queue-order.test.ts`, `test/agent-mail.test.ts`, and `test/harness.mjs`. Inspect and extend existing boundaries instead of duplicating the harness infrastructure.

## Checks and live evidence

Run focused regressions while developing, then `npm run build` and `npm run test:all`. Because this changes runtime behavior and Feed projections, exercise the relevant package and browser journeys from the development guide, including a deterministic browser case that shows Done and Working together across a refresh. Cover applicable runtime/container transports when their production boundary is changed. Report exact unavailable dependencies or failures; do not describe skipped checks as passing.

If configured provider access is available and authorized, validate a delayed native child return with Claude and with Pi using the supported versions and an identified Pi extension. Do not install arbitrary extensions, change credentials, or launch paid inference merely because a fixture passed. If live validation is unavailable, state the limitation explicitly. Fixtures prove Loop's handling of the protocol exercised, not live provider compatibility.

Keep command results, protocol provenance, screenshots, and review evidence in the PR or final handoff. Update canonical documentation for lasting behavior only.

## Loop review team

After implementation and initial validation, use the existing Loop review team through `loop_request_review`. Read [agent-requested review](../../docs/workspace.md) and the available tool's schema and advertised review teams. Select the configured code review team; do not invent an ID, create a replacement team, or spawn independent reviewer subagents. Loop manages the team's reviewers and lead consolidation.

Choose the scope that captures the complete implementation: `uncommitted` for working-tree changes including new files, `staged` for the staged implementation, or `branch` for committed changes against an explicit base. Avoid a partial snapshot or unrelated user changes. Wait for the consolidated report and inspect every reviewer's completion state; a failed, cancelled, or interrupted reviewer is missing coverage, not a clean review. The review must cover the implementation and tests, not just this assignment.

Assess findings against all three areas: runtime identity, scheduling, retention and isolation; harness protocol mappings and transport coverage; and user-visible Feed behavior, controls, regressions and documentation. Preserve the Loop team's configured roles rather than assigning replacement reviewers.

Fix actionable findings and add reproducing regressions where appropriate. Rerun affected checks and request another Loop team review of a fresh snapshot covering the complete revised implementation. Follow-ups on an old review retain its immutable snapshot and cannot establish that later edits were reviewed. Resolve disagreements with code and protocol evidence. Do not declare completion with unresolved correctness findings or omit failed checks. If the Loop review tool or configured team is unavailable, report the missing access and leave the review requirement outstanding; do not substitute self-review or spawned subagents and claim success.

## Single commit delivery

Inspect the final diff, whitespace, migration ordering, and repository status. Stage only changes belonging to this implementation; preserve pre-existing user changes. Create one new commit containing the completed implementation, regressions, and necessary product documentation. Do not rewrite earlier user commits, include generated artifacts/secrets, push, or deploy unless separately requested. Suggested subject: `Track autonomous native continuations across harnesses`.

Return the commit hash, a concise description of observable behavior, checks run and their outcomes, the Loop review reference and reviewer completion states, findings and resolutions, and any remaining upstream or live-validation limitations. Verify that the final committed content matches the latest reviewed snapshot. The prompt bundle's existing commit is baseline material and is not part of this one implementation commit.
