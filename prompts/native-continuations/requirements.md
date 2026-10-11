# Native continuation requirements

## User visible behavior

Treat an agent's completed answer, outstanding background work, and renewed parent execution as distinct facts.

| Event                                                        | Expected Loop behavior                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent finishes run A while background children remain       | Preserve A and its result in Done. Keep the native session available for the children to report back.                                                                                                                                         |
| Child emits progress or finishes without parent resumption   | Record supported activity without creating a parent Working card.                                                                                                                                                                             |
| Parent autonomously begins processing findings after A ended | Create exactly one new run B in the same owner, agent, and conversation; surface B in Working while A remains in Done.                                                                                                                        |
| More child results arrive while B is active                  | Attach the parent's continuing work to B; do not create a card per child, tool, message, or model call.                                                                                                                                       |
| Parent finishes B                                            | Complete B through the normal result path, remove its Working card, and make its result available in Done and the transcript. Preserve A's stored result and history; normal latest-result Feed behavior may replace the displayed Done card. |
| Parent later resumes after B completed                       | Create another distinct continuation run.                                                                                                                                                                                                     |

Do not infer parent activity from assistant prose such as “waiting for subagents”, timestamps, tool names, or mere process existence. Use verified live lifecycle evidence. Do not turn replayed history, child-session output, initialization, settings refresh, or an unrelated native session into a continuation.

Use a truthful trigger label such as “Continued automatically”. Use “Continuing after background work” only when the trigger is known. Do not fabricate a user message, copy the prior answer into the new card, or inject synthetic context into the harness. Native children remain harness-owned; they do not need to become Loop teammate agents.

## Runtime guarantees

- Observe and adopt work that the harness already started. Do not call `prompt`, submit mail, or enqueue a second native execution to manufacture that work.
- Associate normal prompted starts with their existing runs. Create a new continuation only after the preceding logical run has ended. Adapter-internal retries, compaction, and steering may belong to the same logical run.
- Persist a stable identity for each observed execution, scoped to its owner, conversation, native session, and generation. Duplicate events and reconnect reconciliation must not create duplicate runs or results. If an upstream turn ID is unavailable, define the adapter's identity and reconciliation limits explicitly.
- Route output, tools, approvals, live replies, cancellation, results, and notifications through the same applicable behavior as ordinary native runs. Expired decisions must not gain authority over a later generation or run.
- Keep scheduling honest: no queued user prompt may be dispatched concurrently with an adopted continuation in the same native session. Preserve existing ordering rules for other conversations and agents.
- Retain sessions while background work or a pending continuation can still require them. Account for both timeout cleanup and capacity eviction, plus the interval between the last child finishing and the parent beginning its response.
- Cancellation must stop the intended execution and must not cause automatic redispatch. Define and test what happens to outstanding children and late native events after cancellation. Do not hide genuinely continuing native work behind a completed card.
- On restart, process loss, or transport gaps, reconcile only what can be verified. Where continuity cannot be established, preserve output and expose an interrupted or uncertain outcome. Never automatically replay external effects.
- Keep credentials and raw transport details out of browser-visible content. Recheck owner, connection, and generation scope before accepting lifecycle events or decisions.

## Scope

Implement one shared lifecycle mechanism and harness-specific mappings for Claude, Pi, Codex, OpenCode, and supported ACP implementations. Claude and Pi must have end-to-end acceptance coverage. For the others, implement every lifecycle path supported by their verified contracts and expose limitations honestly. A capability is a description of support, not a substitute for implementing available support.

Preserve Loop-managed `loop_delegate` and mail result delivery. Those already create or steer work through a different path; a native lifecycle event for that work must not create another run. Apply the feature to every currently supported production path that launches these harnesses, including local and remote/container paths where applicable. Do not resurrect retired transports.

An arbitrary Pi extension may run background processes without reporting their existence. Detecting the parent's eventual resumption and knowing whether the idle process may safely be shut down are separate capabilities. Implement an explicit retention strategy for unknown background state; do not equate “not reported” with “none”.
