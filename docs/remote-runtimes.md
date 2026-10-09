# Remote execution environments

Harness execution uses a private HAPI Hub and an owner-scoped runner. The server provisions the environment identity, mutually authenticated worker endpoint and allowed project mappings. Browser clients never receive coordinator or provider credentials.

For a single computer, run `loop`; the [managed launcher](harnesses.md#managed-launcher) discovers installed harnesses and connects their existing native accounts. For the server stack, follow [server operation](server.md#local-hapi-and-memsearch-stack). Deployment definitions and pinned versions are in [deployment](../deployment/).

In Settings → Execution environments, select a provisioned environment, connect its providers and map projects to approved directories. An existing native sign-in is verified in the runner's home. A Docker or remote runner has its own home, so an account signed in only on your laptop is not automatically available there. Sign-in and model discovery run inside the chosen environment.

Environment generations fence sessions, decisions and dispatches. Replacing a runner or recovering an uncertain operation requires explicit recovery of that identity; losing a response never authorizes replay. Native conversation context stays with its harness. Loop stores durable dispatch receipts and display projections.

Direct subscription brokers, standalone native hosts and direct Codex app-server inference are no longer selectable execution paths in Loop. Historical conversations and published files remain readable. Reconnect the agent to HAPI and start a new conversation; credentials and native sessions are not copied between machines.

Workspace command MCP brokers are separate from harness execution. Their runtime-host registration remains available for MCP installation and tool hosting; see [workspace features](workspace.md).
