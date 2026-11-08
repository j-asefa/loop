# Documentation

[README](../README.md) is the quick start. These guides describe the code in this repository.

| Guide                                        | Scope                                                             |
| -------------------------------------------- | ----------------------------------------------------------------- |
| [Server operation](server.md)                | Host resource limits, backups and disk pressure                   |
| [Harnesses](harnesses.md)                    | Native discovery, sign-in, models, team handoffs and services |
| [Pairing and recovery](pairing.md)           | Phone access, device trust, tunnels, recovery and fleets          |
| [Architecture](architecture.md)              | Entry points, execution paths, persistence, activities and memory |
| [Contract rules](contracts.md)               | API contract authoring, public projections and boundary evidence |
| [State machines](state-machines.md)          | States, invariants and transition tables; known invalid states    |
| [Workspace](workspace.md)                    | Connections, MCP, files, search, teams and notifications          |
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
