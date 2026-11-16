# Documentation

[README](../README.md) is the quick start. These guides describe the code in this repository.

| Guide                                        | Scope                                                             |
| -------------------------------------------- | ----------------------------------------------------------------- |
| [Server operation](server.md)                | Host resource limits, backups and disk pressure                   |
| [Harnesses](harnesses.md)                    | Native discovery, sign-in, models, team handoffs and services |
| [Pairing and recovery](pairing.md)           | Phone access, device trust, tunnels, recovery and fleets          |
| [Architecture](architecture.md)              | Source map, core boundaries, saved rows, results, contracts, activities and memory |
| [Execution paths](execution.md)               | Local control transport, agent sources and the companion execution authority |
| [Workspace updates](workspace-updates.md)     | Change drains, event sockets, browser signals and page loading |
| [Fleet architecture](fleet-architecture.md)   | Experimental fleet identity, directories, credentials, remote access and mail |
| [Contract rules](contracts.md)               | API contract authoring, public projections and boundary evidence |
| [State machines](state-machines.md)          | States, invariants and transition tables; known invalid states    |
| [Client and host state machines](client-state-machines.md) | Connection lease, browser owner generation, command receipts, workspace socket, lock and upgrades |
| [Workspace](workspace.md)                    | Conversations, Feed, organization, prompt history, notifications and offline behavior |
| [Teams and agents](teams.md)                  | Teams, Markdown agent and team definitions, agent messaging and retiring agents |
| [MCP tools](mcp.md)                           | MCP connections, approvals, tools and GitHub pull requests |
| [Social feeds](social-feeds.md)               | Social feeds, watches and digests |
| [Integration API](cards-api.md)                    | Scoped tokens, workspace reads and Cards synchronization |
| [Development](development.md)                | Tests, builds, packaging and manual verification                  |
| [Fleet acceptance](fleet-acceptance.md)       | Isolated fixture/tunnel runner and separate-host/phone checklist  |
| [Experiment previews](previews.md)            | Try design and runtime branches with separate builds, state and pairing |

Earlier specifications, feedback reports and dated test evidence are retained in Git history. They are not current setup instructions. Record verification results in each PR; supported protocol pins are owned by source/configuration files linked from the guides.

Generated contracts: [workspace and Cards HTTP](openapi.json),
[event channels](openapi-channels.json), [fleet peer HTTP](fleet-openapi.json),
[fleet gateway HTTP](fleet-gateway-openapi.json) and
[fleet administration HTTP](fleet-admin-openapi.json). Regenerate them with
`npm run openapi`; [development](development.md) describes verification.
The [SQL index](sql-index.md) lists every query module's exported functions;
regenerate it with `npm run sql-index`.
