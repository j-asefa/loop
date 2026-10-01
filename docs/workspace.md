# Workspace features

Provider connections determine authentication, models and execution. Agents add instructions and settings; conversations retain their runtime binding. Use [harnesses](harnesses.md) for direct execution and [server operation](server.md) for managed subscription/API setup.

## Conversations and organization

The phone layout has four tabs: **Feed**, **Projects**, **Later** and **Search**, plus an account button for your prompts, notifications and Settings. Projects organize conversations and artifacts; native project bindings also select an existing execution directory. Files can be attached to messages or published as private artifacts with versions. Public intermediate progress and structured activities are distinct from completed answers. Replies and follow-ups retain their selected-message context.

Teams coordinate manager/worker agents through bounded delegation. Deleting a team preserves its agents and history. Archiving affects feed visibility rather than deleting the underlying work. Imports bring existing chat exports into Loop; connecting a provider account does not automatically import website history.

Keyword search works without a provider. Semantic search can use a local embedding model/runtime and reports readiness or failure. Optional OpenAI embeddings require an explicitly selected API connection; subscription connections do not authorize embedding API usage. Search groups matches by thread, remembers recent searches on the device and has a **Your prompts** scope for your own sent messages.

### Feed and reading position

The Feed tab shows how many agents are working right now (9+ above nine). The Feed lists conversations by latest activity ([mobile-return.ts](../src/server/mobile-return.ts)). Each card shows the agent, project, run status and the latest message, which is the result when a run has finished; while an agent works, the card shows its output so far. Filters cover all threads, threads that need you (approvals, paused, failed or interrupted work), and working and queued threads. Result cards with their files and previews stay on agent profiles and project pages. Swipe a card left to snooze it; long-press for run controls. A “while you were away” card summarizes what finished, failed or needs you since the last visit. Loop has no read or unread state.

A thread remembers where you stopped scrolling and reopens there; at the latest output it opens at the latest messages. Unsent drafts are kept per thread on the device. Swiping back returns to the previous page as you left it: the Feed, Later section and Search query and results reappear at the same scroll position while they refresh. These views are kept in memory for the signed-in account only. Pulling down at the top of any page refreshes it.

Replies stay inside the thread. Any message can be replied to, the agent's or your own; your own is quoted as “my earlier message”. Each message has a menu for replying, saving, reminders, forking from that message into a new conversation, reusing it as a prompt, saving it as a snippet (insert with `/` in the composer) and sharing its link. **Jump to…** lists the thread's prompts, results, approvals, failures and saved messages. File activity from a run collapses into one summary that opens a change review. It lists what the agent's tools reported, edit by edit, rather than a diff of the working tree: applied edits are counted, while proposed, unconfirmed and failed edits are shown but not counted, and review prompts cover only files with applied edits. Its follow-up buttons only prefill a prompt to the agent: Loop never applies, commits or reverts files itself, and harness session commands such as rewind stay in the native terminal. Token counts appear when the provider reports usage; Loop does not estimate cost.

### Later, reminders and deferred work

**Later** collects snoozed threads, results and messages, and **Saved**: one list, newest save first, of every result and message you saved. Saving a reply that has a result card saves that result, so the two are always saved together and listed once. As before, a saved result is included in agent memory by default, which now also applies when you save its reply. Saved follows the project and team filters, and every saved item has Reply, which quotes it in its own thread. A snooze returns at a chosen time, when the thread's agent has no active work, or the next time you open a project. The worker surfaces due items and sends a push notification to subscribed devices. Snoozed threads leave the Feed until they return.

The composer's **Send later** menu can queue a message behind the current task instead of steering it, or schedule it for a time up to 30 days ahead. Later → **Scheduled** lists every scheduled message with its recipient and project, where it can be edited or cancelled; a scheduling confirmation links there. The worker submits scheduled messages with their stored idempotency key, so a retry after a crash cannot send twice. If Loop refuses a message when it is due (for example, its agent was retired), it is marked **Not sent** with the reason, in Later → Scheduled and under the Feed's **Needs you**; nothing was sent, and it waits until you choose **Send now** or **Dismiss**. Other errors leave it scheduled and it is tried again. The composer keeps each send's mode and exact time with its key, so retrying after a lost response repeats the original request and the server returns its receipt, even after the scheduled time. The computer must be awake for scheduled or queued work to start. Before a queued run starts, you can edit its message, move it up or down within that agent's queue, or move it to another agent.

The composer's dictation button appears only where the browser offers speech recognition; that browser feature may send audio to the browser vendor's service.

Pending approvals also send a push notification. The notification carries only the agent name and a link to the conversation, never the request's arguments, and approval always happens inside the app so the device lock still applies. Tapping a notification opens its thread at the message it is about: a new result opens at the answer that produced it. If Loop is already open, the service worker focuses it and opens the thread in place.

## Personal prompt history

**Your prompts** (Search, or the account button) is a private, newest-first history of prompts sent across the signed-in owner's projects, with an optional text filter. Entries show their run's receiving agent, project, conversation, attachments, a link to the original message, and Reply, which quotes that prompt in its thread. `/?page=personal` links open this view.

History uses canonical messages and rechecks owner, conversation and project access on every page. Archived work remains readable under the existing retention rules; deleting underlying messages/conversations removes them from history. Agent renames show the current name, while missing agent records show “Recipient unavailable.” Account changes reset the view.

New interactive submissions carry a server-controlled personal-origin marker; internal submissions are excluded. Older messages are included only when they have the submission attachment metadata and an agent run, without native projection/import markers or delegation ancestry. Legacy retry submissions cannot be distinguished reliably from original submissions and may appear; imported or unlinked records without reliable provenance are omitted. The view does not aggregate other owners or deployments.

## MCP tools

In Settings → Tools & integrations, choose a catalog integration or add a custom server. Paste `mcpServers` JSON for command or hosted configurations; complete any required OAuth or credential setup. Installation succeeds only after discovery. Catalog definitions are maintained in [catalog-data.ts](../src/server/mcp/catalog-data.ts), not fetched as executable instructions at runtime.

Connections are workspace-wide for that owner, including future agents and teams; other users do not inherit them. Agent-requested installation requires approval. Connected calls follow the workspace approval preference, with ownership, schema, discovered-tool and run-state checks at dispatch. A read-only annotation does not itself grant authorization. Disabling a connection blocks subsequent calls but cannot undo an already dispatched effect. Unknown outcomes are not automatically retried.

Hosted connections use validated network destinations. Private runtime origins require explicit operator configuration. Command MCPs run locally in companion mode and through runtime infrastructure in server mode. Native host configuration is distinct from workspace MCP configuration.

Charts save numeric data and provenance as snapshots; refresh is a new tool operation. Mermaid diagrams use the native renderer. MCP Apps run in an isolated iframe with a restrictive CSP and no same-origin access to the workspace. Unsupported rich content falls back to saved native/text output. These displays do not bypass the tool broker.

## Workflows

The editor uses the bounded JSON `loop.workflow/v1` format implemented in [server/workflows](../src/server/workflows). A workflow defines inputs, agent roles, sequential agent/approval/save steps, outputs and limits. References may use named inputs or earlier steps; forward references and invalid schemas are rejected. Saved versions and runs retain their selected connection/settings snapshots.

Run a saved version with inputs, review required approval steps and inspect linked child conversations/results. Checkpoints prevent duplicate child submission after restart. Cancellation propagates to the active child. Human approval waits do not occupy a worker slot. Workflow step/time limits apply to native execution, but native internal model calls and token use are not exactly enforceable. The format does not execute arbitrary embedded shell/code.

## Browser and offline behavior

The web app can be installed from an HTTPS origin using the browser's home-screen/app installation flow. A Quick Tunnel origin can change; run `loop pair` and add the new page to your home screen.

The service worker caches public shell assets, not private API responses or credentials. Offline relaunch shows reconnect UI; messages are not queued on the device while offline (scheduled sends are stored on the server). The **Open on another device** option in a thread shows a QR code and link for continuing on your computer or phone; the link carries no credentials. Share links create a draft for review rather than silently submitting work. See [pairing](pairing.md) for device access and reconnection.
