# September feedback

Work is on `feat/reported-bugs-and-agent-teams`, rebased onto `main` after the Loop V0 merge. Migration `010-feedback.sql` adds the feedback features while preserving the runtime accounting and feed revision migrations already on main.

| Report                                  | Change                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic sign-in keeps showing OpenAI  | Provider-first setup separates saved accounts from new connections. Provider identity stays with each sign-in request, including slow refreshes, errors and retries. Failed/interrupted login retries reuse the same account; pending sign-ins can be resumed.                                                             |
| Collapse the input bar                  | Compact launcher, click-away and Escape collapse, explicit collapse control, retained drafts and one-click reopening.                                                                                                                                                                                                      |
| Generate agent avatars                  | Deterministic local SVG avatars, used consistently across feeds and profiles.                                                                                                                                                                                                                                              |
| Running only shows executing agents     | Executing is the default; queued and attention states have separate views. Completed/cancelled runs are excluded, and managers waiting for workers are not counted as executing.                                                                                                                                           |
| Enable semantic search                  | Local MiniLM embeddings, with no provider account required. Enable from Search or Settings. The model downloads once; text and queries stay on the server. The existing optional OpenAI embedding account remains available.                                                                                               |
| Remove duplicate keyword results        | Deduplicate equivalent message/artifact content before pagination, preserving distinct authors and conversations.                                                                                                                                                                                                          |
| Cards open conversations                | Card bodies and Continue open the conversation, anchored to the response. The output icon still opens charts, files and other artifacts.                                                                                                                                                                                   |
| Names/avatars open profiles             | Feed identities, executing agents, conversation identities and search-result names link to profiles.                                                                                                                                                                                                                       |
| Native flowcharts                       | Mermaid blocks render inside messages and feed cards. Every agent has the bundled `loop_diagram` tool; no external diagram MCP installation is needed.                                                                                                                                                                     |
| Message links open the selected message | Explicit message-target state, anchored loading for old messages, focused scrolling, and stale request protection.                                                                                                                                                                                                         |
| Run on a remote machine                 | Owner-scoped runtime machine settings, health checks, encrypted tokens, per-connection host selection, and a remote-only Docker Compose deployment. See [runtime setup](RUNTIMES.md).                                                                                                                                      |
| Integrate Pi.dev                        | Evaluated and documented an adapter design below. A production Pi adapter is **not included** in this branch.                                                                                                                                                                                                              |
| Agents install tools/MCPs               | Agents can request `loop_install_mcp`; the existing approval UI reviews the exact configuration before workspace-wide installation. All current and future agents can request the connected tools; per-agent grants are no longer required. External calls retain their own approvals.                                     |
| Paste MCP JSON                          | Accepts `mcpServers` blocks with command/args/env or HTTPS url/headers, validates the complete configuration, discovers tools and reports per-server outcomes. Exact repeated configurations reuse their records.                                                                                                          |
| Long-press to archive a feed response   | Separate feed-only visibility flag, long press and accessible button, Undo, and Restore to feed from the artifact viewer. History, search, saved files and provider state are preserved.                                                                                                                                   |
| Manager/worker teams and multiple feeds | Create teams with an existing manager and 1–8 workers. The manager delegates bounded tasks, waits durably, then receives results. Each worker response appears in the team feed and All teams. Multi-select filters apply to Feed, Running and approvals. The selected team's composer continues its manager conversation. |

## Follow-up feedback

Agent creation now separates **Agent instructions** (standing guidance for every task) from an optional **Initial prompt** (the first message, which starts work immediately). **Create & start** opens the new conversation and saves output in the selected project. Leaving the prompt blank creates an idle agent. Creation and the initial queued run save in one transaction, and retries reuse the same agent and conversation. Migration `011-agent-creation.sql` stores owner-scoped creation receipts. Creating an agent from the share, workflow or team setup returns to that setup while the initial task runs independently.

MCPs now belong to the whole workspace. Both manual and agent-approved installations are available to all existing and future agents, without a per-agent setup step. Disabling/disconnecting a server applies to every agent, while owner isolation and per-call approvals still apply.

Provider connections now separates account management from setup. Add a provider → ChatGPT or Claude → Subscription or API key opens a focused form for that provider. Existing OpenAI accounts never appear above a new Claude form. Account names are optional, subscription setup retains the runtime-machine choice, and API forms identify the correct key issuer and separate billing.

Sign-in keeps its provider identity before the account list refreshes, exposes explicit cancel/resume controls, and ends with a clear connected screen. Retries check for a login already in progress before starting another, reuse the same connection, and ignore stale responses after navigation. API keys are cleared when changing provider or method. Long account lists keep the title and close button visible.

Remote Codex machines connect directly through the official app-server WebSocket protocol, reusing the host's ChatGPT login. Loop creates separate ephemeral threads, retains native tool configuration and requests full native access. Commands, files, network, skills, plugins and inherited MCPs are available; host administrator policies still apply. Cancellation interrupts only Loop's turn, and disconnect does not sign out the host account.

Claude Code and Codex also have a native host runner that uses the laptop's working directory and existing sign-in. Native Claude has its full tool set, bypass-permissions mode and no Loop-imposed three-turn cap. This is separate from the isolated Docker broker. Native host connections are stored by migration `012-native-hosts.sql`, which preserves existing broker and app-server pairings. See [runtime setup](RUNTIMES.md).

The mobile composer now has labelled, outlined recipient/project fields, 44px controls, an explicit Send button and readable model information. It fits above the phone keyboard while the bottom navigation is hidden. Drafts survive minimizing and team selection. The team selector is a compact summary (one name or a count), opening a searchable selection sheet with a scroll-contained list and focus restoration; multi-team filters no longer sprawl over the feed.

Sending a new message collapses the composer; sending a reply closes the conversation sheet. Both dismiss the keyboard as soon as the server accepts the message, without waiting for feed refresh or the agent's answer. Failed acknowledgements retain the draft and reuse the same request on retry. Sent reply drafts are cleared from storage before the sheet unmounts. Chromium and WebKit coverage holds the refresh open to verify immediate dismissal and checks lost-response retries for duplicate runs and stale drafts.

A searchable 50-entry MCP catalog now covers development, research, productivity, databases, observability, cloud services, design and business tools. Install opens sign-in or a focused credentials form where required; public tools connect immediately. Installed status survives reloads, and retries reuse the existing workspace connection. Custom URL and JSON setup remain available. See the [catalog setup notes](RUNTIMES.md#mcp-catalog).

## Verification

`npm test`: **93 tests passed across 18 files**, including the merged main-branch regressions and workspace MCP coverage. `npm run build`, `npm run smoke:browser`, `npm run smoke:journey`, and both Compose configuration checks passed.

Agent creation coverage verifies instructions on initial and future tasks, one first message/run, selected-project output, blank-prompt behavior, repeated requests, ownership boundaries and full rollback when the queue is full.

The regression suite covers feed-only archive/restore, duplicate search results, older-message pagination, local semantic indexing and disable, owner isolation, durable parallel workers and manager resumption, JSON configuration validation, installation approval, native diagrams, remote runtime routing, and login retry state. Additional regressions cover simultaneous database startup, managers sharing workers across teams, and cancellation isolation.

The browser journey runs in both Chromium and WebKit and covers catalog search/category filtering, credential forms, duplicate-free install/re-enable, persisted Installed status at 320/390/768 widths, provider setup in both themes at 320/390/430/768 widths, saved-account separation, provider identity before bootstrap finishes, failed and lost login responses, duplicate-free retries, stale response isolation, pending sign-in resume/cancel, and API validation/update, subscription handoffs with protocol fixtures, composer draft retention, team creation and filtering, executing-only Running, card/profile navigation, long-press archive/search/Undo, older message anchors, native diagrams with visible labels and narrow-screen layouts. The separate browser smoke suite covers imports, folders, sharing, themes and offline behavior. Visual review also corrected clipped agent names and diagram labels lost during sanitization.

Live catalog discovery connected to Context7 (2 tools), DeepWiki (3), Exa (2), Hugging Face (4), and Cloudflare Docs (2), without account credentials or tool invocation. Authenticated integrations have sourced setup configurations and protocol tests; real sign-in to all 50 providers has not been performed.

Direct Codex coverage includes authenticated WebSocket pairing, encrypted tokens, owner isolation, existing-account setup, full native access with unchanged host tool configuration, native command/file/permission approval responses, unrelated-session filtering, quota/transport failures, provider identity checks, cancellation and account-preserving disconnect. A real unsigned Codex CLI 0.148.0 listener accepted a full-access ephemeral thread and wrote a harmless file through native command execution without changing saved host settings or starting a model turn.

Native host tests launch the actual service with fixture CLIs and verify host project file IO, inherited configuration/MCP environment, bearer authentication, native tool flags, API-billing exclusion, cancellation and unchanged sign-in after disconnect. Browser coverage includes native Claude pairing and first output, initial prompts with lost-response retry, searchable multi-team selection, light/dark composer layouts at 320/390 widths, 44px controls and simulated keyboard positioning. Authenticated inference remains fixture-based.

Screenshots: [team picker](evidence/team-picker.png), [mobile composer](evidence/mobile-composer.png), [composer above keyboard](evidence/mobile-composer-keyboard.png), [initial prompt](evidence/agent-initial-prompt.png), [MCP catalog](evidence/mcp-catalog.png), [mobile team feed](evidence/mobile-team-feed.png), [anchored message and native diagram](evidence/message-anchor-diagram.png), [provider chooser](evidence/mobile-provider-choices.png), [Claude setup](evidence/claude-connection-setup.png), [Claude sign-in](evidence/claude-sign-in.png), [Claude API setup](evidence/claude-api-setup.png), [workspace MCP availability](evidence/workspace-mcp.png).

A real local model check produced 384-dimensional embeddings and ranked a car/automobile paraphrase at approximately 0.728 cosine similarity versus 0.050 for an unrelated cooking sentence. This check used the actual downloaded model, not a fixture or paid API.

The actual Playwright configuration from the report was run through the broker in an isolated Docker container: 25 tools discovered, bundled Chromium navigation and subsequent tab inspection succeeded. `scripts/smoke-mcp-runtime.mjs` reproduces that check with Docker available.

Live authenticated Claude/Codex allowance usage and execution on a separately provisioned remote machine still require real accounts and that machine. The automated provider and remote-routing checks use explicit fixtures. The existing local service was updated from this branch at the user’s request; its data and provider credentials were preserved. No new real provider account or remote machine was connected.

## Pi.dev integration design

Pi is a runtime with its own provider and model selection. It should be integrated at the same broker boundary as Codex and Claude Code. Pi documents JSONL RPC for isolated subprocess integrations, and recommends its exported `RpcClient` for TypeScript hosts. See [Pi RPC](https://pi.dev/docs/latest/rpc) and [CLI integration](https://pi.dev/docs/latest/cli-integration).

A follow-up adapter should:

1. Add a distinct runtime identifier, without treating every Pi connection as subscription billing. Discover its configured model/provider pairs.
2. Package a pinned Pi CLI in the isolated image and keep its credentials in a dedicated per-connection volume.
3. Map prompt, cancellation and completion events to Loop's existing streaming/checkpoint protocol. Keep Loop's conversation and feed history authoritative.
4. Expose Loop tools through the runtime, preserving workspace ownership and installation/tool-call approvals. Native filesystem/shell capabilities need an explicit workspace policy.
5. Add protocol fixtures plus real sign-in and model-access checks before enabling the provider picker.

The new remote runtime boundary and existing model adapter interface provide the integration points. This report deliberately distinguishes that design from a tested, shipped Pi connector.

## Response failures and runtime commands

A reported empty answer was a failed MCP call: the browser tool advertised JSON Schema 2020-12 while Loop's validator only understood older drafts. The validator now supports modern dialects while still rejecting invalid arguments. Run state and error details travel with feed items and conversation messages, and feed revisions change even when a run stops without another text chunk. Empty provider results cannot silently complete. Failed conversations offer an explicit, idempotent retry; partial answers and historical failures remain saved.

Both message composers now include a searchable **Commands & skills** picker, also opened with `/` or `$`. The catalog comes from the selected native machine. Codex skill input and `/review` use app-server RPCs; Claude's discoverable slash commands are passed unwrapped to its official CLI. Context remains available and commands needing persistent terminal state are identified as unavailable. Runtime setup and limitations are documented in [RUNTIMES.md](RUNTIMES.md#commands-and-skills-in-messages).

Migration 13 adds run-state feed invalidation. Applying it to a disposable copy of the live database preserved all record counts and passed integrity checks. Automated coverage includes the original schema, schema validation rejection, empty and partial failures, cancellation, cross-owner access, incremental status refresh, native command discovery without inference, direct Codex skill/review calls and Claude command dispatch. The production runtime image's real pinned Codex and Claude binaries both discovered a temporary skill without an account or model turn.

Browser evidence: [Codex commands](evidence/commands-codex.png), [Claude commands](evidence/commands-claude.png), [failed response and retry](evidence/failed-response.png).

## Review fixes, approvals and search readiness

The three PR findings are addressed with regression tests. MCP query keys and stdio environment values are redacted from model input, tool results, saved artifact versions and app resources, including escaped strings and URL-encoded forms. Delegated children can bypass queued work that blocks their managers, while paused work and active agent leases remain protected. Search deduplication uses the explicit assistant-message association and matching content; separate files, repeated messages and edited artifacts remain separate results.

Approval cards now open a focused review with the agent, tool, complete arguments, original prompt, expiry and conversation link. Technical request data is collapsed. Approve and Reject remain explicit; duplicate clicks, request failures and already-handled approvals are covered by the browser journey. The layout is checked at 320 and 390 pixels in both themes.

Conversation sheets have a visible, sticky drag handle and pull-down dismissal. Downward pulls from the top dismiss; scrolling within history, text inputs, upward/sideways pulls and cancelled or short gestures retain their normal behavior. Closing preserves the reply draft. Chromium coverage includes actual touch dispatch; WebKit covers the touch handlers and pointer dragging.

Semantic search now exposes preparation, batch progress, failures and readiness in Search and Search preferences. Keyword results remain available during setup and after a four-second semantic query deadline. Downloads have a timeout so a stalled model fetch cannot occupy the index worker indefinitely. Title-only files are indexed, entirely blank records are excluded, and failed batches retry with a backoff. Migration 14 stores the worker's index state so the API can report errors rather than silently hiding them.

The existing live account had semantic search enabled but no indexed items at the start of inspection. The local model loaded successfully and the background worker indexed all 76 nonempty records; a live query then returned hybrid results. Migration 14 was rehearsed on a fresh copy of the live backup with unchanged record counts and valid app/auth databases. Model inference checks stay local; browser status fault injection uses fixtures.

Evidence: [approval review](evidence/approval-review.png), [dark approval review](evidence/approval-review-dark.png), [chat drag handle](evidence/chat-drag-handle.png), [semantic status](evidence/semantic-status.png).

## Personal workspace access

Single-user installations now open directly into the workspace locally. Fresh installs need no Loop registration, password or login cookie. Existing installs reuse their original workspace owner, preserving conversations, agents and encrypted provider/MCP connections. Remote access passes through one authenticated gateway; the gateway's private token is required at the Loop origin. Host/origin checks and loopback-only defaults prevent public requests from entering through the local access path. Separate Loop accounts remain available with `LOOP_AUTH_MODE=multi-user`.

Migration 15 stores the selected personal workspace identity. Multiple existing accounts require an explicit choice instead of silently choosing a workspace. Access regression tests cover identity across restarts, existing-account reuse, separate multi-user data, disabled account endpoints, cross-site and forged-header requests, gateway tokens and invalid deployment settings. Browser smoke checks open, import into and reload a personal workspace without registration or cookies.

## Attention, previews and project agents

Needs your attention is a full-width, high-contrast entry above the agent strip, with a count on Running. Each attention card and approval summary has an accessible ×. Dismissing a failed/interrupted task acknowledges it without changing its history; dismissing queued, paused or approval-waiting work cancels it and its dependent tasks and rejects pending approvals. Stale executing requests are rejected, and the acknowledgement persists across reloads. Conversation history and saved outputs remain available.

Conversations no longer begin with the continuation banner. Moving selected messages to another agent remains a secondary action after the history, including imported conversations.

Previews render complete Markdown before limiting visible blocks, preserving inline links, emphasis and code fences. Playwright JSON result lists become readable linked entries, browser navigation results show their destination, and tables, code and images use appropriate previews. A visible View full output action opens the complete saved content. No stored output is rewritten.

Projects has its own desktop and phone navigation entry, a New project action and a view showing only the agents assigned to the selected project (including its subfolders). Create an agent there or add an existing agent. The project selection now persists even without an initial prompt and can be changed through Edit agent. New tasks default to that project; replies keep their conversation's project, and explicit Workspace inbox destinations remain supported. Moving an agent does not move previous conversations or files.

Migration `016-projects-and-attention.sql` adds agent membership and durable attention acknowledgements. Existing initial-task project choices are recovered when present. Regression coverage includes owner isolation, idempotent dismissal, pending approval rejection, project moves and replies, and complete Markdown/structured previews. The Chromium and WebKit journey covers these interactions at phone widths in both themes.

Four further PR review findings are covered by regression tests. Codex attaches native skill inputs only for names in the host catalog, preserving ordinary `$HOME`/`$PATH` text. Search opens an edited artifact itself when it no longer matches its source message. JSON and manual MCP installs encrypt URL query credentials alongside other authentication; startup repairs older records, and result redaction handles those values too. Workspace MCP discovery and re-enable atomically check the combined tool catalog (120 tools / 400 KB), reporting an actionable error before an oversized integration can break every agent's request. This budget applies to Loop's attached MCP descriptors, not the native tools on remote Codex/Claude hosts.

Tools & integrations now offers a persistent **Allow connected tools** approval preference, with a shortcut from approval details. Enabling it resumes unexpired waiting calls on connected MCPs and permits subsequent calls without prompting, retaining invocation records and uncertainty protection. It is scoped to the workspace owner and does not approve installations or workflow reviews. **Ask every time** restores prompts for new calls. Migration 17 stores the preference; existing workspaces retain prompting until their owner changes it.

Web search/fetch previews show source links and short excerpts, omitting repeated titles, repository statistics and transport metadata. Full outputs remain intact. Conversations use nearly the entire phone viewport with 16px message text, larger code/table text, a single history scroller and compact reply controls; drag-down dismissal and drafts are retained.

## Final answers and agent traces

Loop's orchestration loop no longer stops after seven model/tool rounds. Managed Claude runs also no longer receive a three-turn limit. Work continues until the provider finishes, a tool needs attention, the user pauses/cancels, or the existing execution timeout/provider limits apply. Pause/resume checkpoints preserve completed tool calls without replaying them.

Feed and profile Outputs contain completed answers, excluding active/failed placeholders and intermediate tool artifacts. Each model round has a separate durable trace; only the last answer is saved as the conversation response. Completion publishes an answer at the top of the feed, including runs that began before the loaded page. Running reuses the feed's formatted preview card while keeping pause, cancel and conversation controls.

Agent profiles offer **Traces** beside Outputs, Your prompts and Files. This paginated timeline shows public updates and tool activity, with links to complete tool results and conversations. Native Codex and Claude activity is captured too; private reasoning/thinking blocks are not stored as traces. Existing saved files remain available.

Migration 18 backfills historical tool artifacts and checkpoint turns, excludes previous conversation turns, and repairs old concatenated final answers when the content still matches the generated version. User edits are retained. Search excludes intermediate artifacts and coalesces matching message/output pairs, including old records without message metadata; distinct messages and edited files remain searchable. Client pagination merges stable result IDs and discards stale requests.

Regression coverage includes a 13-round run paused after the old limit, cancellation, owner isolation, durable trace pagination, migration preservation, native activity filtering, final-answer publication and search deduplication. Both browser engines cover formatted Running previews, Feed exclusion, profile Traces, full tool results and phone layouts in both themes.

The latest review fixes also cover cross-site MCP OAuth returns with a valid owner-bound nonce while retaining gateway checks, default-project versus explicit-inbox routing, heterogeneous search highlights, and serialization of approval preference changes with worker transitions.

Validation: 143 tests in 26 files, production build, full Chromium and WebKit journeys, and unsigned real Codex/Claude runtime checks passed. One Chromium attempt timed out in the pre-existing sign-in retry journey; the complete rerun passed. Migration rehearsal on the live backup preserved 12 agents, 18 conversations, 72 messages, 64 artifacts, 36 runs and all seven encrypted credentials; both databases passed integrity checks.

Browser evidence: [Running preview](evidence/running-preview-dark.png) and [agent Traces](evidence/agent-traces.png).

## GitHub review failures and tool error recovery

MCP tool responses with `isError: true` now retain their credential-redacted explanation, saved result and failed trace. Loop returns that error to the agent so it can correct its next request or explain the blocker. Anthropic receives the explicit `is_error` flag; OpenAI and subscription runtimes receive the error marker and content in their conversation history. Reusing a completed call's identity returns its saved result, including errors, without another external call. Transport failures still stop with an unknown outcome and are not replayed. Direct tool runs without an agent show the specific error instead of the generic failure.

For the reported GitHub review, five draft comments survived the failed submission. The agent attempted `REQUEST_CHANGES` against a PR owned by the same account, then attempted to create a second pending review. The old implementation discarded GitHub's error response, so its exact original wording cannot be recovered. The draft remains available to submit as a comment. Diagnosis used read-only GitHub requests; no review or comments were published.

Claude's internal `StructuredOutput` tool and acknowledgement no longer appear as public activity or successful tool output. Previously saved records remain intact but are excluded from Traces and Running previews. Actual MCP errors open with their explanation visible in Traces. The latest posted PR finding is also fixed: live refreshes preserve an Earlier traces cursor when a burst creates an unloaded gap, including after pagination previously reached the end.

Regression coverage distinguishes received application errors from uncertain transport failures, exercises a corrected review submission with both approval modes, checks redaction and cached failure results, preserves final-only Feed output, and checks error propagation through the actual Anthropic SDK. Runtime protocol fixtures exclude formatting receipts while retaining real native tool failures. Browser coverage verifies expanded error details and two 90-entry live bursts with complete, duplicate-free pagination.

Validation: all 150 tests across 27 files, the production build, and full Chromium/WebKit journeys pass. The Chromium journey exposed an existing assertion that read Feed before streaming had completed; it now waits for the completion state before checking publication. [Tool error on a phone viewport](evidence/mcp-tool-error.png).
