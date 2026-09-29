# Working on Loop

Start with [README.md](README.md) for build and run commands. Load only the guide relevant to the task; [docs/README.md](docs/README.md) is the full index.

| Task                                                 | Read next                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Server, authentication, deployment or remote runtime | [Server operation](docs/server.md)                                              |
| CLI, direct harnesses, ACP or managed launcher       | [Harnesses](docs/harnesses.md)                                                  |
| Device authentication, tunnels or reconnect          | [Pairing](docs/pairing.md)                                                      |
| Runtime routing, persistence, activities or memory   | [Architecture](docs/architecture.md)                                            |
| MCP, workflows, teams or workspace features          | [Workspace](docs/workspace.md)                                                  |
| Tests, builds or CI                                  | [Development](docs/development.md)                                              |
| Expo shell                                           | [mobile/AGENTS.md](mobile/AGENTS.md), then [mobile/README.md](mobile/README.md) |

Keep one canonical explanation per topic and link to it. Verify commands against package scripts and CLI parsing, behavior against production entrypoints, and pins against their source files. Historical plans and validation reports live in Git history; record new execution evidence in the PR rather than presenting it as permanent product behavior.

Preserve owner/profile isolation, durable dispatch identities and generation-bound decisions. Never replay an uncertain external effect automatically. Keep native context owned by its harness and credentials out of browser-visible content. Add regressions at the production boundary being changed; use [development](docs/development.md) to choose checks. Distinguish fixture coverage from live provider/device validation.
