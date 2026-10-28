# Status ledger

Update after every meaningful step. A fresh session must be able to resume from "Next step" alone. Record dates as absolute dates.

| PR | State | Branch | PR URL | Review passes | Reviewed head | Next step |
| --- | --- | --- | --- | --- | --- | --- |
| 1 integration tokens with scopes, reads | todo | | | 0 | | Contract-discipline PR 11 (#244) and closeout #245 merged 2026-10-28. Verify that all HANDOFF step 1 cleanup PRs have merged; then read pr-01 and branch from origin/main |
| 2 request identity, writes open | todo | | | 0 | | After PR 1 merges |
| 3 token reads of the event stream | todo | | | 0 | | After PR 2 merges |
| 4 outbound webhooks, one event kind | todo | | | 0 | | After PR 3 merges |

States: todo, in progress, checks green, review requested, fixing findings, ready to merge, merged, blocked.

## Scope catalog

(PR 1 records the final scope names here, with the routes each one admits, so later PRs and the owner read one list)

## Blocked

(none)

## Found, not fixed

(behaviour defects exposed by this work, with route, evidence and why the fix is out of scope here)

## Decisions made during implementation

(record each open decision you resolved, with the PR number and the reason)

## Review history

(one line per review pass: date, PR, reviewed head, review id, pass number, P0/P1 count, security findings yes/no, reviewer coverage complete yes/no, what was fixed)
