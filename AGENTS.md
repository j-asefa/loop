# Working on Loop

Start with [README.md](README.md) for build and run commands. Load only the guide relevant to the task; [docs/README.md](docs/README.md) is the full index.

| Task                                                 | Read next                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Host operation or deployment                         | [Server operation](docs/server.md)                                              |
| CLI, harness discovery or native launcher       | [Harnesses](docs/harnesses.md)                                                  |
| Device authentication, tunnels or reconnect          | [Pairing](docs/pairing.md)                                                      |
| Runtime routing, persistence, activities or memory   | [Architecture](docs/architecture.md)                                            |
| MCP, teams or workspace features                     | [Workspace](docs/workspace.md)                                                  |
| Tests, builds or CI                                  | [Development](docs/development.md)                                              |

Keep one canonical explanation per topic and link to it. Verify commands against package scripts and CLI parsing, behavior against production entrypoints, and pins against their source files. Historical plans and validation reports live in Git history; record new execution evidence in the PR rather than presenting it as permanent product behavior.

Preserve owner/profile isolation, durable dispatch identities and generation-bound decisions. Never replay an uncertain external effect automatically. Keep native context owned by its harness and credentials out of browser-visible content. Add regressions at the production boundary being changed; use [development](docs/development.md) to choose checks. Run `npm run check` before every PR and record its output there. Distinguish fixture coverage from live provider/device validation.

Loop has no installed base to preserve: every installation starts fresh, with a new data directory and newly paired devices. Don't keep or add code for earlier Loop versions, their stored data, file layouts, service units, environment variables, names or wire formats. Compatibility with external systems (providers, harness CLIs, the OS, browsers) stays.

Loop ships only the companion workspace (`loop start`), including its Docker companion. There is no hosted server profile or separate server sign-in.

## Evidence for review

Reviewers should identify the relevant evidence in the diff and PR:

| Rule | Evidence to look for |
| ---- | -------------------- |
| Owner/profile isolation | New reads and writes use the requesting owner and intended profile; boundary tests cover another owner's access and the affected profiles. |
| Dispatch identity and generation | A new external effect has a durable identity recorded before dispatch; decisions are checked against the current session generation. |
| Uncertain effects | Timeouts and disconnects preserve an uncertain outcome and do not automatically submit the effect again; a regression exercises the production retry/recovery caller. |
| Native context and credentials | Browser responses and events expose explicit safe fields; harness-owned session context and credentials stay on their owning side of that boundary. |
| Source and API boundaries | Imports obey the [source layers](docs/architecture.md); new routes use the typed registrar and named legacy inventories only shrink. |
| SQL query modules | Domain SQL lives in [per-table modules](src/server/sql/); preparation is lazy, rows use existing schemas, and the [SQL inventory](test/sql-inventory.test.ts) file allowance only shrinks; migrated files have no direct SQL calls. Migration and projection infrastructure exemptions stay explicit. |
| Formatting exceptions | The [formatting ignore list](.prettierignore) only loses entries, together with formatting the removed files; no new exemption or broader pattern is added. |
| No compatibility with earlier versions | Removing code that only served earlier Loop versions or their data is expected; restoring it is not a fix. Check instead that every path the current build creates still works. |
| Verification claims | The PR records the submitted commit, commands, observed exits and relevant limitations. Fixture results are labelled separately from live provider, tunnel or device validation; a requested or timed-out review is not an approval. |

State observations in PR descriptions: for example, “the fixture rejected an old generation” or “the command exited 0,” with the test or command that established it. Do not turn those observations into claims about untested providers or devices. The [development guide](docs/development.md#manual-verification) defines the required checks; review teams inspect snapshots and do not run them.
