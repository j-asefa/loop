# Workspace features

Provider connections determine authentication, models and execution. Agents add instructions and settings; conversations retain their runtime binding. Use [harnesses](harnesses.md) for direct execution and [server operation](server.md) for managed subscription/API setup.

## Conversations and organization

Feed, Running, Search and Saved provide workspace views. Projects organize conversations and artifacts; native project bindings also select an existing execution directory. Files can be attached to messages or published as private artifacts with versions. Public intermediate progress and structured activities are distinct from completed answers. Replies and follow-ups retain their selected-message context.

Teams coordinate manager/worker agents through bounded delegation. Deleting a team preserves its agents and history. Archiving affects feed visibility rather than deleting the underlying work. Imports bring existing chat exports into Loop; connecting a provider account does not automatically import website history.

Keyword search works without a provider. Semantic search can use a local embedding model/runtime and reports readiness or failure. Optional OpenAI embeddings require an explicitly selected API connection; subscription connections do not authorize embedding API usage.

## MCP tools

In Settings → Tools & integrations, choose a catalog integration or add a custom server. Paste `mcpServers` JSON for command or hosted configurations; complete any required OAuth or credential setup. Installation succeeds only after discovery. Catalog definitions are maintained in [catalog-data.ts](../src/server/mcp/catalog-data.ts), not fetched as executable instructions at runtime.

Connections are workspace-wide for that owner, including future agents and teams; other users do not inherit them. Agent-requested installation requires approval. Connected calls follow the workspace approval preference, with ownership, schema, discovered-tool and run-state checks at dispatch. A read-only annotation does not itself grant authorization. Disabling a connection blocks subsequent calls but cannot undo an already dispatched effect. Unknown outcomes are not automatically retried.

Hosted connections use validated network destinations. Private runtime origins require explicit operator configuration. Command MCPs run locally in companion mode and through runtime infrastructure in server mode. Native host configuration is distinct from workspace MCP configuration.

Charts save numeric data and provenance as snapshots; refresh is a new tool operation. Mermaid diagrams use the native renderer. MCP Apps run in an isolated iframe with a restrictive CSP and no same-origin access to the workspace. Unsupported rich content falls back to saved native/text output. These displays do not bypass the tool broker.

## Workflows

The editor uses the bounded JSON `loop.workflow/v1` format implemented in [server/workflows](../src/server/workflows). A workflow defines inputs, agent roles, sequential agent/approval/save steps, outputs and limits. References may use named inputs or earlier steps; forward references and invalid schemas are rejected. Saved versions and runs retain their selected connection/settings snapshots.

Run a saved version with inputs, review required approval steps and inspect linked child conversations/results. Checkpoints prevent duplicate child submission after restart. Cancellation propagates to the active child. Human approval waits do not occupy a worker slot. Workflow step/time limits apply to native execution, but native internal model calls and token use are not exactly enforceable. The format does not execute arbitrary embedded shell/code.

## Browser and offline behavior

The web app can be installed from an HTTPS origin using the browser's home-screen/app installation flow. A Quick Tunnel origin can change; use a stable HTTPS hostname to keep the home-screen installation working across restarts.

The service worker caches public shell assets, not private API responses or credentials. Offline relaunch shows reconnect UI; there is no background-send queue. Share links create a draft for review rather than silently submitting work. See [pairing](pairing.md) for device access and reconnection.
