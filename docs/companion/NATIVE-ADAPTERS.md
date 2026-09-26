# Local workspace architecture

`loop <harness>` acquires one process-identity lock per `LOOP_HOME`, enables the selected installed harness, performs legacy migration, starts the local worker and opens one phone connection. Subsequent commands call a private loopback administration endpoint and join the same workspace. No Loop cloud backend, remote container broker or user account is required.

The public listener serves packaged React/PWA assets and the existing Express workspace API. Hashed device credentials, HttpOnly/SameSite cookies, exact Origin/Host checks and CSRF tokens protect the API and WebSocket upgrade. A separate bearer-authenticated loopback listener handles desktop administration. QR redemption is explicit, single-use and expiring. Devices may be revoked without cancelling work. Public URLs rotate with Quick Tunnels.

Companion mode uses the same React screens and SQLite domain services as the server profile in this repository. Feed projections, folders, artifacts/versions, FTS search, imports, teams, workflow execution and MCP approval/provenance remain local. Optional semantic indexing uses a local embedding model. Explicit API-key connections retain Loop's original provider loop; native connections never fall back to it.

## Native ownership

One durable conversation binds a harness, native session identifier, directory and initial configuration. One owned native process per active conversation isolates failure and cancellation. Native history owns model context; Loop stores display projections and never reconstructs managed session context from its rendered transcript. Explicitly selected cross-agent transfers are quoted input to a new conversation. A recovered native session resumes via its native ID.

The host bounds execution and evicts idle processes. Per-conversation generations bind events, tool calls and decisions to the correct run. Native session/turn IDs are never selected by arbitrary browser paths. Desktop `--resume` is an explicit handoff; external Codex inventory supports read/fork, not live takeover.

Before a prompt is sent, its durable intent is recorded. Dispatch acknowledgement, completion and uncertain outcomes are separate states. Restart marks active native turns interrupted and expires decisions; it never automatically resends uncertain work. REST submission keys bind to input and target. Native decision receipts bind to generation, request and answer digest. Tool brokers retain invocation identity and reject replay of an uncertain external call.

## Workspace tools

A private, authenticated local MCP bridge issues a distinct credential for each native conversation generation. Codex, Claude and OpenCode receive process/session-local MCP configuration; Pi loads a local extension. Native harnesses retain their existing tools/MCP configuration. Browser clients cannot use this bridge. Published tool names have stable connection/tool identities, and permissions are rechecked at invocation.

The bridge exposes Loop's diagram, MCP installation and authorized team delegation tools, plus installed workspace MCP tools. It waits for actual Loop approvals/delegations without queuing another model prompt. Rich results are stored by the existing broker and rendered by Loop's charts, Mermaid and sandboxed MCP App components. Cancelling or disposing the owning native generation invalidates the bridge.

## Events and transport

Public events use WSS; native stdio and OpenCode SSE stay loopback/local. SQLite event IDs supply replay cursors. Every host boot has a new epoch. An invalid epoch/cursor triggers a snapshot refresh and resumes from a cursor captured when subscribing. Output projections are coalesced; native frames, tool input/results, socket buffers, workers and session items have bounds. A socket exceeding its buffer budget must reconnect for current state.

## Differences from the old runtime

Native conversations can run concurrently, including several conversations belonging to one agent. Explicit API connections keep the existing per-agent serialization and checkpoint behavior. Native mid-turn pause, terminal rendering and takeover of other live processes are unavailable. Workflow step/time limits apply, but native internal model-call/token counts are not enforceable through these adapters. Semantic search readiness, unsupported catalogs and provider billing constraints are visible rather than reported as successes.

The implementation does not require ACP. An ACP adapter can implement the same native boundary where its negotiated capabilities preserve the behavior above. ACP itself does not provide the workspace database, phone security, reconnect protocol or rich-result host.
