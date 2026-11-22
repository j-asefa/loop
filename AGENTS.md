# Working on Loop

Start with [README.md](README.md) for build and run commands. Load only the guide relevant to the task; [docs/README.md](docs/README.md) is the full index.

| Task                                               | Read next                                                                  | Canonical example                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Host operation or deployment                       | [Server operation](docs/server.md)                                         | —                                                         |
| CLI, harness discovery or native launcher          | [Harnesses](docs/harnesses.md)                                             | —                                                         |
| Instruction files each harness loads               | [Instruction files](docs/harnesses.md#instruction-files)                   | —                                                         |
| Device authentication, tunnels or reconnect        | [Pairing](docs/pairing.md)                                                 | —                                                         |
| Runtime routing, persistence, activities or memory | [Architecture](docs/architecture.md)                                       | —                                                         |
| A state, transition or writer of a stateful record | [State machines](docs/state-machines.md)                                   | [run-state.ts](src/shared/run-state.ts)                   |
| MCP, teams or workspace features                   | [Workspace](docs/workspace.md), [teams](docs/teams.md), [MCP](docs/mcp.md) | —                                                         |
| Tests, builds or CI                                | [Development](docs/development.md)                                         | —                                                         |
| Add or change a workspace route                    | [Route recipe](docs/contracts.md#recipe-add-a-workspace-route)             | [webhook-routes.ts](src/server/webhook-routes.ts)         |
| Add or extend a SQL table module                   | [SQL recipe](docs/architecture.md#recipe-add-or-extend-a-sql-table-module) | [mcp-preferences.ts](src/server/sql/mcp-preferences.ts)   |
| Add a state or transition                          | [State recipe](docs/state-machines.md#recipe-add-a-state-or-transition)    | [queue-machine.ts](src/server/queue-machine.ts)           |
| Add an external effect                             | [Effect recipe](docs/execution.md#recipe-add-an-external-effect)           | [execution-commands.ts](src/server/execution-commands.ts) |

Keep one canonical explanation per topic and link to it. Verify commands against package scripts and CLI parsing, behavior against production entrypoints, and pins against their source files. Historical plans and validation reports live in Git history; record new execution evidence in the PR rather than presenting it as permanent product behavior.

When a guide and the code disagree, follow the code at its production entrypoint and list each inconsistency in the PR.

Never run full test suites locally; full suites run only in CI. For every change, run only focused, related tests locally and record their results in the PR. Rebase only when the PR has merge conflicts. See [development](docs/development.md#manual-verification) for verification commands and evidence.

Preserve owner/profile isolation, durable dispatch identities and generation-bound decisions. Never replay an uncertain external effect automatically. Keep native context owned by its harness and credentials out of browser-visible content. Add regressions at the production boundary being changed; use [development](docs/development.md) to choose focused checks. Distinguish fixture coverage from live provider/device validation.

Loop v0.1.0 has an installed user base. Upgrades must preserve historical data and conversations, including saved answers, published files and their references, and related durable identities. Validate migrations and stored-record readers against records that released versions could create; a fresh database alone does not establish upgrade safety. Keep compatibility at storage boundaries where it is needed to retain readable history. Never reconstruct missing history by automatically replaying uncertain external effects.

API-only breaking changes are permitted. Preserving earlier wire shapes or mixed-version fleet operation is not a requirement by itself. Current pending command identities must still survive reloads and uncertain responses. Changes to saved launch state must keep existing workspaces accessible.

Loop ships only the companion workspace (`loop start`), including its Docker companion. There is no hosted server profile or separate server sign-in.

## Evidence for review

Reviewers should identify the relevant evidence in the diff and PR:

| Rule | Evidence to look for |
| ---- | -------------------- |
| Owner/profile isolation | New reads and writes use the requesting owner and intended profile; boundary tests cover another owner's access and the affected profiles. |
| Dispatch identity and generation | A new external effect has a durable identity recorded before dispatch; decisions are checked against the current session generation. See the [effect recipe](docs/execution.md#recipe-add-an-external-effect). |
| Uncertain effects | Timeouts and disconnects preserve an uncertain outcome and do not automatically submit the effect again; a regression exercises the production retry/recovery caller. See the [effect recipe](docs/execution.md#recipe-add-an-external-effect). |
| Native context and credentials | Browser responses and events expose explicit safe fields; harness-owned session context and credentials stay on their owning side of that boundary. |
| Source and API boundaries | Imports obey the [source layers](docs/architecture.md); new routes use the typed registrar and named legacy inventories only shrink. See the [route recipe](docs/contracts.md#recipe-add-a-workspace-route). |
| SQL query modules | Domain SQL lives in [per-table modules](src/server/sql/); preparation is lazy, rows use existing schemas, and the [SQL inventory](test/sql-inventory.test.ts) file allowance only shrinks; migrated files have no direct SQL calls. Migration and projection infrastructure exemptions stay explicit. See the [SQL recipe](docs/architecture.md#recipe-add-or-extend-a-sql-table-module). |
| Formatting | All source, test and script files use the pinned formatter; no repository ignore exceptions are added. |
| Historical data preservation | Released data remains stored and readable after upgrades. Migration fixtures retain content, identities and references; current readers accept historical values that released writers produced. API shape compatibility alone is not required. |
| Verification claims | The PR records the submitted commit, commands, observed exits and relevant limitations. Fixture results are labelled separately from live provider, tunnel or device validation; a requested or timed-out review is not an approval. |

State observations in PR descriptions: for example, “the fixture rejected an old generation” or “the command exited 0,” with the test or command that established it. Do not turn those observations into claims about untested providers or devices. The [development guide](docs/development.md#manual-verification) defines the required checks; review teams inspect snapshots and do not run them.

Phrase a pattern finding as what is wrong (file and line), the repository's pattern, and the recipe or canonical example to follow. When a finding repeats one already fixed in an earlier PR, the fix also adds a recipe step, a narrow bound or a check message, and removes any guidance line the code no longer matches.
