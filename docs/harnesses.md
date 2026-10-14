# Native harnesses

Run `loop` or `loop start` in a project directory. One workspace discovers Codex, Claude Code, Pi and OpenCode on PATH, checks each installation and verifies its account independently. Missing or broken harnesses do not block the others or phone pairing.

```sh
loop
loop start --project /absolute/path/to/project
loop start --providers codex,claude
```

The default selection is `installed` (all four supported harnesses). Saved provider selections are reused. `openai` selects Codex, `anthropic` selects Claude, and `both` selects Codex and Claude. `loop doctor --json` checks installation without making a model request. Missing harnesses are not installed automatically. In Settings → Provider connections, check installed runtimes, sign in or enable a newly installed harness without stopping the workspace.

## Agent worktrees

Each native harness agent gets a persistent Git worktree and branch per project on first use. Its conversations reuse that worktree, including uncommitted changes, across turns, harness switches and restarts. Different agents, owners and Loop data directories get separate worktrees. New worktrees start from the project’s committed `HEAD`; edits and untracked files in the original checkout are not copied. Projects need a Git repository with an initial commit.

Worktrees live under the repository’s Git common directory in `loop-agent-worktrees`, with branches named `loop/agent-<identity hash>`. Loop does not automatically remove or merge them. Existing native sessions in the shared checkout require a new conversation; their context and files are preserved. Missing or mismatched worktrees block execution. API-provider agents do not launch a local harness or have a local checkout.

**Checkout records.** When a native run starts, Loop reads the worktree with read-only Git and records its branch, `HEAD`, the merge-base with the project checkout, and whether tracked or untracked changes were already present. When the run reaches a terminal state it records the new `HEAD`, commits ahead of and behind the project checkout, the files changed against that base with line counts, tracked uncommitted changes, untracked file names, a patch stored at capture time (at most 300 KB, shortened on a line boundary and marked), and what the branch's local remote-tracking ref said, with its timestamp (or that Git could not answer); Loop never fetches, commits, pushes or reverts. A run that ends more than once is recaptured at its latest end; a failed recapture clears the earlier observation rather than redating it. The worktree belongs to the agent rather than the conversation, so other runs active on the same checkout during the interval are listed as overlap; the record brackets an interval and does not claim exclusive authorship. Capture runs asynchronously beside native sessions. Capture commands that inspect the working tree run against a temporary Git directory that Loop owns: a minimal configuration carrying only the object format, the branch's tracking settings and the line-ending and comparison settings, with repository-local exclusions, a copy of the checkout's `HEAD`, index and refs, and the repository's objects attached read-only through alternates. Nothing under the repository's own `.git` directory is read while a command runs, so filters, diff drivers, text conversion, attributes, hooks, promisor remotes and transports configured there cannot execute, whoever changes them and whenever; the directory is removed afterwards and nothing is written back. Attributes are read as usual so line-ending normalisation applies, but the isolated configuration defines no filter or diff driver, so an attribute that names one selects nothing that runs; files whose attributes select a filter (Git LFS, for example) are compared as raw content and marked as such. Capture commands see no other Git configuration: the user's global and the system configuration are disabled (only their line-ending and comparison settings are carried over), inherited `GIT_*` variables are dropped, file-system monitoring, transports, credentials and prompts are disabled, and submodules are never entered. A run that is cancelled or interrupted is observed again once the harness has actually stopped. Reftable repositories are not supported. The start capture has a twenty-second budget because it precedes dispatch; a slow repository records a failed start rather than delaying the agent. One capture owns a run at a time across the API and worker processes; a request that arrives while one is in flight makes it run again, so the record ends on the latest observation. Each observation keeps its own id: a recapture archives the previous one, so a brief citation keeps resolving to exactly what it cited, and the run's published results are recorded as changed so a brief generated before the capture ended picks the evidence up. Runs that end while the host is down are captured by the worker in the background, without delaying dispatch, and labelled as captured late when the run ended more than a minute earlier. A brief can cite a checkout only once its capture has ended. The implementation is [run-checkouts.ts](../src/server/run-checkouts.ts); a capture failure is recorded on the run, never raised into its launch.

## Native behavior and billing

Harnesses own their context, tools, configuration and credential homes. Loop invokes their native protocols and adds pairing, durable work, approvals, files and team communication. It does not take over a live terminal session. Project selection is not shell confinement: native processes have their OS user's access.

| Harness | Default automatic setup | Mid-turn messages |
| --- | --- | --- |
| Codex | Verified native subscription | Live steering |
| Claude Code | Verified native subscription | Live steering |
| Pi | Existing native configuration; provider charges may apply | Live steering |
| OpenCode | Existing native configuration; provider charges may apply | Next-turn queue |
| Custom ACP | Explicit desktop registration | Next-turn queue |

There is no billing fallback after an authentication failure. Model catalogs and effort choices come from native discovery; `native-default` follows the harness default. Account verification and catalog discovery do not submit a model prompt. Installation is not proof of authentication.

Each result shows its recorded input/output token counts at the bottom. Direct Codex reports during a turn; direct Claude Code reports with its turn result, including cached input tokens. Counts are omitted when no usage was reported; older native turns are not backfilled. These counts measure recorded turn usage, not the subscription's remaining allowance or reset time. Other native harnesses do not yet supply token counts to this display.

Codex async questions appear in **Needs you** with their answer choices while the agent continues working. If native work finishes first, Loop keeps the run waiting for your answer and continues in the same native thread when you submit it. Cancelled or replaced sessions expire these decisions; resuming native history does not reopen old questions.

Codex resumes request thread metadata without copying all saved turns into the startup response. Codex retains the full model context and attachments; Loop keeps its persisted conversation display. Reconnecting therefore does not require transferring the entire file-heavy transcript through one protocol message.

For an explicit executable, existing billing configuration, native session resume or a custom ACP agent:

```sh
loop codex --billing existing
loop claude --project /absolute/path/to/project
loop pi
loop opencode
loop acp --executable /absolute/path/to/agent --acp-arg serve
```

These commands enable the harness in the same running workspace. Executable paths are chosen on the computer, never supplied by browser input. See `loop --help` for options. Native history discovery and explicit forks are available in the app; a fork does not silently transfer native context between harnesses.

## Cross-harness teams and handoffs

Put agents in the same team to give them a shared roster and communication tools, regardless of harness. `loop_message` sends a durable message; `loop_message_status` checks delivery and replies. `loop_delegate` assigns a task to a teammate. `loop_handoff` sends the next task, a context summary, an optional workspace reference and published file IDs, asking the recipient to acknowledge ownership in the same thread. Repeated tool calls with the same receipt do not duplicate delivery.

A handoff does not transfer a native session, stop the sender's process, copy a checkout, or grant new permissions. The sender should finish its current edits before handing work over. Agents on the same machine can refer to shared paths; across machines, use published files or committed branches. Live input is used only where the harness supports it; other messages queue for the next turn.

## Sign-in and upgrades

Settings → Provider connections offers native account status, sign-in, model refresh and supported harness upgrades. Complete the provider flow, then enable/refresh the connection. Native credentials stay with the CLI. Closing the sign-in sheet does not cancel an active attempt; cancelling is explicit. Attempts expire after 15 minutes or a workspace restart. Loop does not replay uncertain sign-in steps or installers.

Finish active runs and sign-in before upgrading a harness. Loop uses the installation's package manager without sudo, checks the resulting version, and attempts rollback when supported. An interrupted upgrade stays unconfirmed until its state is checked. Container installations are updated with their image.

## Recovering retired connections

Migration 071 makes direct connections retired by migration 067 eligible for verification again, preserving their IDs, agents, teams, conversation history and native bindings. Local startup verifies saved native registrations before reconnecting them. Server subscription accounts can be checked through Provider connections. Intentionally disconnected accounts remain disconnected. Failed or uncertain work is not automatically replayed.

Connections from the earlier HAPI release stay disconnected; see [architecture](architecture.md#execution-paths). Previously saved launcher execution flags are normalized on restart; explicit `--execution docker`/`both` is replaced by the Docker deployments below.

## Containers and services

For a paired workspace with its own provider home, use `docker compose -f compose.companion.yaml up --build -d`. Its harnesses execute directly inside the container. For a server with subscription runtimes, use the root Compose stack; see [server operation](server.md) and [remote runtimes](remote-runtimes.md). A container does not inherit your host's native sign-in.

`loop service install` installs per-user application and connection services using the saved project and launch options. `loop restart` replaces the application while the connection service retains its public address and paired devices. `loop service uninstall` removes the services while preserving workspace data. See [pairing](pairing.md).
