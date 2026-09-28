# Direct activity display implementation notes

This is an **integration-in-progress** record, not a claim of end-to-end support. `ActivityPanels.tsx` provides transport-independent, display-only plan, file-change and command-output components. `direct-activities.ts` extracts explicitly structured upstream fields into transient display values. It is not a new persistence/wire contract. These helpers still need to be connected to the shared activity records and the conversation/history projection owned by the shared-contract implementation.

## Verified sources and mapping status

Sources inspected on 2026-09-27. Mutable upstream documentation/source was inspected; no live paid harness session was run and no particular installed agent version is certified by this work. Tests are deterministic authored fixtures, not recordings from authenticated real agents.

| Direct runtime | Structured source | Implemented extraction | Remaining integration / limitations |
| --- | --- | --- | --- |
| Codex App Server | [Official App Server documentation](https://learn.chatgpt.com/docs/app-server), `turn/plan/updated`, `commandExecution`, `fileChange` | Replacement plans, completed aggregate command output, explicit exit code, per-file patches and rename destination, proposed/executed/failed/declined states | Streaming output-delta accumulation and event emission into the shared reducer still required. `turn/diff/updated` should not duplicate per-file changes. |
| Claude stream-json | [Official SDK message types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py), assistant tool-use / user tool-result IDs | Explicit TodoWrite input; Bash output only when correlated to the actual invocation; Edit replacement fragments from the matching input/result | Input fragments are **not full-file snapshots**. Full edit-result schema/version validation, lifecycle integration and shared emission pending. Opaque `tool_use_result` must not be guessed. No exit code is parsed from prose. |
| Pi RPC | [RPC framing/events](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md), [bash tool](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/bash.ts), [edit tool](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts) | Tool update/final snapshots, explicit edit `details.patch` or `details.diff`, combined Bash content and upstream truncation flag | Retain tool-call ID/input correlation in adapter integration. Built-in Bash result details do not supply an exit code; leave unknown. Do not read the upstream temporary output path through an unauthorised browser path. No plan is inferred from prose. |
| OpenCode HTTP/SSE | [Server documentation](https://opencode.ai/docs/server/), [todo implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/todo.ts), [edit implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/edit.ts) | Structured todos, explicit `metadata.filediff.patch` / `metadata.diff`, tool output | Current edit metadata can arrive before final completion, so it is `unknown` until the final tool status confirms execution. Bash metadata and version compatibility require further recorded-fixture validation. Session/generation filtering stays in the adapter. |

The helper is deliberately not a capability advertisement. Missing integration is **not** labelled upstream unsupported. API-provider and ACP capabilities belong to their respective owners' matrix entries.

## Settings and commands

Existing direct connection and native session ownership are preserved. Codex `turn/start` now sends the documented `effort` field instead of `reasoningEffort`. A focused request-shape regression test covers this correction.

The existing command picker now keys requests by both agent and conversation, rejects delayed results from the previous conversation, uses stable command keys, and replaces the catalog on explicit refresh. Catalog replacement removes old commands. Automatic workspace-event refresh is intentionally left for the persisted catalog path: the existing endpoint launches a native probe and must not be called for every streamed output event. This still uses the existing catalog endpoint: live session catalog persistence/revision semantics require the shared backend integration.

Existing model/effort controls are retained. Capability-based session-setting discovery, confirmed/requested values, revision-checked mutations and authoritative rejection/refresh handling remain pending the shared setting contract and endpoint. Do not present these as completed or as upstream unavailable.

## Display safety and bounds

React text rendering escapes paths, plans, commands and output; none become executable markup or file links. Diff rendering preserves explicit content and status; it never applies changes. Before/after panes distinguish omitted content from explicit null create/delete sides. Command output retains at most 48,000 characters in the visual panel; diffs are likewise bounded per content pane and labelled when truncated. These visual limits supplement, not replace, the shared reducer's byte and aggregate bounds.

Output uses a keyboard-focusable scroll area. Reading older output disables automatic following; the user can explicitly return to the latest output. File panes stack on phone widths. Color is accompanied by the original patch markers and textual statuses.

## Validation

- `npx vitest run tests/direct-activities.test.ts tests/activity-panels.test.tsx --maxWorkers 1`: 12 passed (structured extraction, hostile content, bounded output, explicit/unknown status, rename paths, Codex effort request).
- `node --import tsx --test --test-concurrency=1 test/adapters.test.ts`: six existing fixture lifecycle tests passed after the effort-field correction.
- `npm run typecheck`: passed; `npm run build` also passed after the final formatting/effort correction (including a fresh typecheck).
- `node scripts/activity-panels-browser.mjs`: Chromium component fixtures at 390×844 and 1280×844 passed. Includes escaping, horizontal overflow, output-scroll retention on update, delayed catalog response after conversation switch, dynamic removal and selection.

This host required local ARM Debian browser libraries plus DejaVu fonts. They were extracted under ignored `.tmp/browser-libs` (no system changes). Browser invocation used `FONTCONFIG_FILE="$PWD/.tmp/fonts.conf"` and `LD_LIBRARY_PATH="$PWD/.tmp/browser-libs/usr/lib/aarch64-linux-gnu:$PWD/.tmp/browser-libs/lib/aarch64-linux-gnu"`. On a standard Playwright host, run the script directly; `CHROMIUM_PATH` is optional.

Component browser fixtures do not establish persisted conversation rendering, reconnect correctness, authoritative setting confirmation, or real harness compatibility. Those gates remain open until shared integration lands.
