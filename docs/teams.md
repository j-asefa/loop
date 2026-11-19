# Teams

**Team presets.** New team offers **Review code changes**, **Ask an LLM council**, **Build a feature** and **Investigate a bug**, as well as a custom team of existing agents. Choose a project and a connected provider/model; expand the role settings to use different connections. Loop creates the manager and workers together and records the preset version, instructions and role assignments. Retrying creation with the same request does not create duplicates. Changes to built-in presets do not rewrite existing teams. Each generated agent remains editable from its profile.

**Local code review.** Choose **Review changes** on a project or a review team's directory entry. In a laptop workspace, select uncommitted changes (including non-ignored new files), staged changes, or committed branch changes against a base. The project must be bound to the Git repository root and have an initial commit. Loop captures the diff, baseline versions of changed files and repository context twice, rejecting a capture if the snapshots differ. It does not checkout files, change the index, create a PR or run tests/CI.
The three reviewers get fresh conversations and the same immutable snapshot; the lead runs after they finish, with their reports and actual completion states, and verifies and consolidates findings. Existing delegation records provide queue dependencies and cancellation of reviewers with the lead.
New uncommitted reviews reject `assume-unchanged` and `skip-worktree` index flags and content-conversion attributes (filters, EOL normalization, ident expansion, working-tree encodings, automatic CRLF conversion). Clear those settings or use staged/branch review. Unchanged files are context, read on demand; a context file whose Git object is no longer available reports that rather than reading the current checkout. Capture, storage and read limits are in [review-snapshot.ts](../src/server/review-snapshot.ts) and [review-access.ts](../src/server/review-access.ts).

**Agent-requested review.** An agent that is not on a review team can ask one to review its work, for example when you tell it to get a review before opening a pull request. Its `loop_request_review` tool lists the review teams it may use and captures the agent's own checkout — its [worktree](harnesses.md) for native harnesses, otherwise the project's repository — with scope `branch` (default, against `main`), `uncommitted` or `staged`. The checkout must share the project's Git repository. The call returns a durable review ID immediately.

**Follow-up review.** When an agent asks again from the same conversation about the same checkout and scope, Loop compares the contents of every file either snapshot changed with the last full review's snapshot. If that conversation's latest review of that scope completed with a report, every reviewer of the last full review completed, and the lines added or removed since the full review are at most 400 and at most half of the change, the lead reviews alone: it receives the earlier report and the lines added and removed since the previous snapshot, and no reviewers run. A deleted or moved line, an untracked file and a mode change all count. A rebase that leaves those files alone adds nothing; upstream edits to them count as new. Omitted files are not compared, as no review reads them. The report and `loop_review_status` state `depth: follow_up` and the earlier review's ID. Anything else is a full review, as is a request with `depth: "full"` and every review started from **Review changes**.
For new asynchronous requests, it also records one queued review follow-up in the original conversation before returning. The current turn may finish; its result stays in Done while the follow-up remains visible in Queued. Once the review lead ends and the requesting turn completes, the normal worker runs the follow-up, which retrieves the consolidated outcome and continues the task without another user prompt. Review completion is not approval. Follow-ups use the existing native session and queue for all harnesses; they do not hold a tool call open or interrupt an active turn.
Later sends in that conversation retain queue order. While a queued follow-up is waiting for review or provider availability, work and mail in other conversations can advance. A paused requester or retired agent holds the follow-up. A failed or interrupted requester cancels the queued follow-up rather than automatically starting another effect after uncertain work; review status stays available for an explicit recovery task. Cancelling the requester cancels its follow-up, and the queued follow-up can also be cancelled separately.
Its generated input cannot be edited or moved to another conversation. An unavailable selected provider holds the follow-up in the queue until it reconnects; the worker also checks this before dispatch if disconnection races its claim. The follow-up retains its selected provider and queued execution settings, with the current workspace permission mode captured when the review is requested; it never switches billing or providers automatically. Cancel it and send an explicit task to use a different provider. Uncertain native dispatch is never automatically replayed.
Removing the review team does not erase a captured report or its requester provenance. Explicit blocking requests do not acquire asynchronous follow-ups. Use `loop_review_status` with that ID to read progress and, once finished, the lead’s consolidated report and each reviewer’s state. Omit the ID to recover this agent’s ten most recent requests, including requests from earlier turns or calls that timed out. Status reads never start another review. Optional `wait: true` waits for completion, but may exceed a harness timeout; recover through the status tool.
Edits made after capture are not covered. Cancelling the requester cancels the lead and its reviewers. Retrying the same tool call returns the same review rather than starting another; a new call starts a new snapshot review.

Review teams can use any connection, including harness subscriptions. API reviewers receive the snapshot in their history and expose only `loop_review_read`, which reads captured text from the owner's review, and reject external MCP calls. Native reviewers receive the snapshot in their first turn and get `loop_review_read` through Loop's tool bridge, but they keep their harness's own tools and permissions; read-only access is an instruction, not an enforced boundary. Follow-ups in a review conversation keep the same snapshot binding. Feature-building and bug-investigation presets use normal agent permissions and existing delegation rules.

**LLM council.** Based on Karpathy's [llm-council](https://github.com/karpathy/llm-council). The chair delegates the question to three members, then sends each member the other members' answers, anonymized and in shuffled order, to rank. Members never rank their own answer. The chair adds up the rankings with Borda points, checks the key claims itself and writes one answer, followed by the points, the disagreements and its confidence. The role settings open by default so each member can use a different model. The process lives in the agents' instructions and runs through ordinary delegation; Loop does not enforce the anonymization or the shuffling.

The report lists omitted files: hidden files, common credential files, generated/vendor output, submodules, symlinks, changed binary files and large files. Unchanged binary context files are not in that list; they report "binary, omitted" when first read. These filename filters are not a content secret scanner; selected source text is sent to the chosen providers. Oversized captures fail explicitly, and review agents have an execution time limit ([agent-runtime.ts](../src/server/agent-runtime.ts)). The report's status panel shows reviewer failures separately from completed reviews; no tests are claimed. **Check for newer edits** compares the current repository capture with the reviewed snapshot. That check is a point-in-time observation, not a continuous watch. Applying fixes is a separate task with an editing agent.

A team is a manager and up to 8 workers. Each agent keeps its own provider connection, so one team can mix API agents and native Codex, Claude Code, Pi and OpenCode agents. You talk to the manager in the team thread. Open **Teams** from the desktop workspace sidebar or **Projects → Agent teams** on a phone to browse teams, open a team feed, or add an existing connected agent as a worker. The Feed's team filter also opens a selected team's activity.

Turn off **Show results and threads in feed** in a team's directory entry, or select one team in the Feed's team filter to reach the same setting. Its current and future cards are hidden from **Done** and **Threads** in **All teams**, including project thread lists and a project-filtered Feed. Selecting the team or an agent explicitly still shows its results and threads. **Replies**, **Needs you**, **Working**, **Queued**, project result history, and saved results remain available. The preference is saved per team in its owning workspace, applies across devices, and can be turned back on at any time. An agent's work outside that team is unaffected.

**Delegation.** The manager's `loop_delegate` tool starts focused tasks for workers, which run in parallel; their updates appear in the team's feed. By default the call waits for every result. With `wait: false` the manager keeps working or finishes its turn, and each worker's result arrives later in the delegating conversation as a turn labelled **Result from @worker**, once per final state. A finished result remains deliverable if its worker is later retired or removed from the team. While the manager is working in another team conversation, results wait rather than start a second session. Cancelling the manager's task also cancels its workers' tasks and any of their results still waiting to be read; results from workers that finished but weren't delivered yet are dropped, so a cancelled manager is never restarted.

Agents can also [discover, message and hand work to one another](#agent-messaging) without a shared team. `loop_delegate` remains available only to the manager of an active team.

## Markdown agent and team definitions

Choose **Customize → From Markdown** when creating an agent, or **From Markdown** when creating a team. In **Teams → Add worker**, choose **Create worker from Markdown** to create and attach a new worker. Agent creation opens the private library on the selected connection's workspace; team and worker creation use the team's workspace. Libraries belong to their owner on that workspace and are not synced between computers. Create an example, import a `.md` file or paste Markdown, then **Save definition**. Saved definitions can be edited, downloaded or deleted there and reused with different names and connections.

Loop stores the original Markdown in `LOOP_DATA_DIR/loop.db`, under its owner's account. Keep that database in backups. Importing copies the file; Loop does not watch the original file or write to a harness's configuration directories. Existing agents retain their own settings when a definition changes or is deleted. Creating from a definition does not start work; the ordinary agent form still offers an optional initial prompt.

Agent files use YAML frontmatter followed by the instructions, like the basic [Claude Code subagent format](https://code.claude.com/docs/en/sub-agents):

```markdown
---
name: code-reviewer
description: Reviews changes for correctness and missing tests.
---

Read the relevant code, identify concrete bugs, and explain each finding
with file references. Do not edit files.
```

`kind: agent` is optional. `name` follows Loop's handle rules: 3–32 letters, numbers or hyphens, beginning with a letter; names are normalized to lowercase. `description` is optional library text (up to 1,000 characters). The nonempty Markdown body becomes the agent's instructions. Optional `model` names a model from the selected connection's catalog; omitted or `inherit` uses the model chosen in Loop. Optional `effort` must be reported by that model; otherwise choose the runtime default or a reported level before creation. If a requested model is unavailable, choose another explicitly in the creation form. Importing an agent fills an editable draft; the saved definition stays unchanged.

A team file defines one manager and one to eight workers. Each role has a unique name, instructions, and optional description, model and effort. The Markdown body is optional shared guidance, prepended to every role's instructions:

```markdown
---
kind: team
name: Feature team
description: Implement and independently review a change.
manager:
  name: feature-lead
  instructions: |
    Implement the change. Use loop_delegate to request an independent
    review, address confirmed findings, and report changes and checks.
members:
  - name: feature-reviewer
    instructions: |
      Review for correctness and missing tests. Return findings with
      file references. Leave edits to the lead.
---

Follow the project's conventions. Distinguish evidence from assumptions.
```

Choose a project and each role's name, connection and model before creating the team. Every role becomes an ordinary Loop agent, editable from its profile and usable with any supported connected harness or API provider. Creation is atomic: invalid settings, duplicate handles or a full team leave no partial agents. Retrying the same creation request returns the recorded result. Worker imports obey the existing eight-worker limit and fixed code-review-team roles.

Files are limited to 128 KB and each agent's resulting instructions to 12,000 characters, including shared team guidance. Unknown fields are rejected; Claude-specific `tools`, `disallowedTools`, hooks, permissions, skills and MCP declarations are not translated. Configure tools and permissions in Loop and the selected harness. YAML aliases, custom tags and references to other files are not supported. Use one self-contained team file, or import worker files individually into an existing team.

The authenticated API exposes `GET /api/agent-definitions` for summaries and `GET /api/agent-definitions/:id` for a file and its parsed definition. Save with `PUT /api/agent-definitions/:id`, a client-generated UUID, and `{markdown, version}`: use version `0` for a new definition and the returned version for later edits. Delete with `DELETE` and `{version}`. Stale edits and deletes return 409. Creation uses `POST /api/agent-definitions/:id/create` with `{version, selection: {connectionId, model}, idempotencyKey}`; optional `folderId`, `name`, `teamId` (agent files only), and `roles` keyed by the file's original role names select the destination and override names, connections, models or effort. An explicit role model overrides the file's model; otherwise the file's model precedes the default selection. Omit a worker's `folderId` to inherit its team's project, or pass `null` for Workspace. The definition version is checked before creation; a previously recorded retry remains retrievable after the definition changes or is deleted.

## Agent messaging

Ordinary agent runs have `loop_agents`, `loop_message`, `loop_message_status` and `loop_handoff` through the shared API/native tool layer ([agent-mail.ts](../src/server/agent-mail.ts)). `loop_agents` searches and paginates the current owner's non-retired local agents and, on an enrolled companion, authorized fleet peers. Results retain the owning machine, stable agent identity, runtime and availability without instruction prompts or connection secrets. Another execution machine behind a server is eligible through local routing; a separately enrolled companion uses direct fleet mail. Merely appearing as a linked server source in the unified Feed does not grant mail access. Disconnected recipients can have accepted mail waiting. Retired agents, unsupported connections and snapshot review targets are refused; review runs keep their restricted tool catalog.

Native harnesses share the generation-scoped [workspace tool bridge](../src/server/native-tool-bridge.ts), which states what it owns and how adapters connect; [workspaceMcp](../src/adapters/workspace-mcp.ts) encodes that connection for each native protocol. Antigravity's version-dependent availability is described in [harnesses](harnesses.md#antigravity).

`loop_message` takes a recipient `to` agent ID and a body of up to 12,000 characters. With no `scope`, a recipient on the sender's active team gets the existing team routing; otherwise the message starts a **direct** thread. Explicit `scope: "direct"` also works between teammates. Explicit `scope: "team"` requires active team membership. Replies pass `threadId`, use its stored scope and reject conflicting scope or target arguments. Sending without `threadId` creates a new mail thread. That shared mail ID links the participants across their separate conversation IDs; each message records its sender and recipient conversations and runs. It is distinct from a manually created card group ID: manual grouping does not rewrite agent mail or automatically add future cards. The automatic Agent thread view follows that mail ID as replies arrive. Sending to oneself is invalid.

Recipient status tools hide unread message subjects and previews while still reporting delivery state. Senders can inspect their own mail; the owner's Agent mail view retains its full history.

Fleet mail retains each participant's machine and agent identity. Agent mail and
Agent thread cards label remote participants with their machine; identical agent
IDs on different machines remain separate participants. A destination link appears
after the original acceptance identifies its conversation. Opening it uses that
machine through the current gateway, including when the destination is now the
gateway itself. An unavailable directory leaves the link disabled with a refresh
or direct-open action. Pending or unconfirmed delivery does not create a local
conversation or imply that the recipient read the message.

A direct thread has two fixed participants and default conversation bindings. The sender is bound to the conversation that started it. Optional `conversationId` selects an eligible recipient conversation; otherwise ordinary delivery creates a dedicated conversation using the recipient's own project and connection, without assigning it to a team. Ordinary replies return to those bindings even when either agent works elsewhere. Sending from another conversation does not replace a binding. An unusable destination fails visibly; start a new thread to contact the agent again. Removing team membership or deleting a team does not invalidate an independent direct thread. Team threads keep their membership rules and prefer the recipient's active team conversation, then the remembered thread/delegation conversation or the manager's team thread, otherwise a new team conversation.

For direct messages, `interrupt: true` automatically selects the recipient's most recent running conversation, including when replying with `threadId`. An explicit `conversationId` takes precedence and may select a different destination for an interrupt in an existing thread. If no task is running, normal routing applies. Loop records the selected destination when accepting the message; retries and release from held or pending delivery keep it even if another task starts. The first delivery establishes the recipient's default binding, including when an interrupt starts the thread in an existing user or team conversation. Later interrupts do not replace that binding for ordinary replies. Conversation eligibility checks still apply: an unusable stored binding or selected destination fails visibly instead of selecting another task.

Mail queues behind work in its destination. The worker also prevents mail from starting a competing execution when that agent is busy in another conversation, including paused work or work awaiting approval. Ordinary native user conversations can still run concurrently, and mail that has not started does not block them in unrelated conversations. `interrupt: true` steers only a live run in the selected conversation when its actual runtime takes live input: API/subscription, Codex, Claude Code, Pi, Muse Code and Antigravity. OpenCode, Grok Build and ACP queue instead. A manager waiting on blocking delegation is never interrupted. Agents cannot wait synchronously for answers inside a mail call: they should finish their turn so the reply can start the next one.

Acceptance is durable, not proof of reading. **Waiting for recipient availability** means accepted but not yet submitted, for example during disconnection or queue pressure; **Queued** means a recipient turn exists. Recovery retries only undispatched mail or steering definitively never read. An uncertain delivery stays **Delivery unconfirmed, not resent**. Cancelling the recipient turn prevents recovery from recreating it. Refused mail and mail from queued, paused, cancelled, failed or interrupted turns remain in owner-visible history but do not grant later model context, memory or attachment access. If a queued turn's provider is removed, or disconnected and replaced on the agent, delivery fails visibly without switching providers. Direct mail creates no delegation relationship. Delegated results retain their manager cancellation rules.

`loop_handoff` carries a next task, context summary, workspace reference and published files and requests an acknowledgement in the thread. It does not transfer native sessions, stop the sender, grant manager capabilities or give user approval. Messages appear as **Message from @agent** in conversations and the Feed, explicitly granting no additional authority. Up to 8 files may be included, restricted to files the sender published or can read through attachments to its current conversation; recipients read them with `loop_read_file`. Owning a file alone does not authorize an agent to forward it. Different runtimes need published/attached files, not assumptions about shared paths. Recipient turns use the recipient's own connection and its subscription limits or API billing; there is no provider or billing fallback.

One run can send 8 messages. A thread pauses after 30 messages, or when a pair reaches 20 messages in an hour across direct and team threads in this owner/source. A paused thread can hold 30 further messages. The workspace can also retain up to 100 accepted, undispatched messages; excess sends are refused explicitly. From an agent profile, **Agent mail** shows direct and team threads, participants, previews, delivery state and available destination links. **Messages** still shows assistant output history. The existing **Team messages** entry filters the same controls to a team. **Resume** releases held messages in order and renews the allowance; a temporary obstruction re-pauses before the blocked message and reports how many were released, refused or remain held. Automatic recovery never releases held messages.

## Retiring agents

An agent profile has **Retire agent** and **Restore agent** actions. Retirement
removes the agent from active pickers and blocks new work, including automatic
routing and delegation. Already accepted work can finish; conversations, results,
files and bookmarks remain. **Settings → Manage agents → Retired agents** provides
access to retired profiles and restoration. A team manager must be restored before
it can accept a new message. Deleting a team preserves its agents and history.
Deletion uses one confirmation sheet, a bounded request and a retryable error state.
