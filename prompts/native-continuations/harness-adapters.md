# Harness lifecycle mappings

Read [requirements](requirements.md) first. Each adapter translates its native protocol into the shared lifecycle; the Feed must not contain provider-specific heuristics.

## Verify protocol evidence

Inspect supported versions in `deployment/versions.json`, installed-version checks in `src/host-control.ts`, package pins, and the actual native executable where available. Consult official documentation or upstream source for those versions. Record exact fixture provenance and any version-dependent differences in the handoff. Current upstream documentation alone does not prove the installed protocol supports an event.

For each harness establish: parent identity, execution start, logical completion, background-work visibility, replay semantics, cancellation, reconnect support, and which production transport carries them. Do not infer a protocol from the event names in these notes.

## Claude

Start in `src/adapters/claude.ts` and `runtime/claude-steering.mjs`. Verify live parent execution boundaries and background-task notifications in the supported Claude stream/control protocol. Distinguish parent-session continuation from child output using structured identities and provenance.

Also trace the subscription executor in `runtime/entry.mjs`: its controlled path currently closes stdin after a result. A fix confined to the persistent direct adapter cannot establish continuation support on that path. Verify and adapt transport lifetime and server observation together.

The existing `foreignResult()` guard protects a submitted prompt from unrelated, child, or non-human results. Preserve that protection. Extend correlation so a result belonging to an adopted autonomous parent execution can settle that execution. Simply deleting the origin/active checks can complete the wrong run. Keep steering interrupts, approvals, and error handling tied to the matching execution.

Verify what `result` means when background work remains and what observable event proves the parent has resumed. Track background lifetime separately from parent execution. If the protocol has no dedicated start event, justify and test a structured live-event boundary; never classify every assistant message or task notification as a new turn. A child finishing is not itself a parent start.

Upstream starting point: [Claude subagents](https://code.claude.com/docs/en/agent-sdk/subagents). Follow its SDK references and verify against the supported CLI; Loop55's adapter uses the CLI protocol.

## Pi

Start in `src/adapters/pi.ts`. At preparation time Loop55 emits running on `agent_start` and completes on `agent_settled`. Ensure autonomous starts also reset turn-local flags and enable steering and cancellation; those must not depend solely on Loop55 calling `prompt()`.

Keep automatic retries, compaction, and immediate follow-ups within their verified logical lifecycle. Do not finish on a lower-level `agent_end` if Pi will continue before `agent_settled`. Check how installed extensions can deliver findings or trigger fresh parent execution after settlement.

Support parent continuation independently of a particular subagent extension's tool name or output format. Background-task enumeration may require a separate documented integration; unknown extension state must follow the shared retention policy. Test both an uninterrupted parent loop waiting on tool work and a delayed new parent loop after settlement.

Upstream starting points: [Pi RPC lifecycle](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) and [extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md). Resolve any repository moves and version differences before relying on them.

## Codex

Start in `src/adapters/codex.ts` and trace applicable runtime implementations. Preserve native thread and turn IDs from start/completion events through the shared contract. Keep child threads separate. Account for starts preceding prompt responses, reconnect history, and starts occurring after a previous logical run ends. Do not use a global running flag as turn identity.

Inspect `runtime/codex-session.mjs` and `src/server/codex-app-server.ts` explicitly. Their operation cleanup unsubscribes from threads, and the direct remote path closes its connection. Establish how later execution remains observable on each supported path; extending the direct adapter alone is insufficient.

## OpenCode

Start in `src/adapters/opencode.ts`. Investigate session busy/idle events, message identities, history reconciliation, and the adapter's `activeTurn`/prior-message filtering. Enabling adoption without enabling output capture would produce an empty Working card. Repeated busy or retry statuses are not separate runs. Recover complete output after a stream gap before declaring completion, and prove that history reconciliation cannot manufacture a continuation.

## ACP

Start in `src/adapters/acp.ts` and the pinned ACP SDK. Distinguish updates delivered during an outstanding prompt request from any documented independently initiated work. Capability-gate autonomous lifecycle support by what the implementation actually exposes. Continue projecting ordinary activity for implementations without sufficient evidence; do not invent terminal boundaries from silence or tool statuses. State the limitation explicitly and cover it with a regression.
