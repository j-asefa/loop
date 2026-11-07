# Native harnesses

Run `loop` or `loop start` in a project directory. One workspace discovers Codex, Claude Code, Pi, OpenCode, Antigravity (`agy`), Muse Code and Grok Build on PATH, checks each installation and verifies its account independently. Missing or broken harnesses do not block the others or phone pairing.

```sh
loop
loop start --project /absolute/path/to/project
loop start --providers codex,claude
```

The default selection is `installed` (all seven supported harnesses). Saved provider selections are reused. `openai` selects Codex, `anthropic` selects Claude, and `both` selects Codex and Claude. `loop doctor --json` checks installation without making a model request. Missing harnesses are not installed automatically. In Settings → Provider connections, check installed runtimes, sign in or enable a newly installed harness without stopping the workspace.

## Agent worktrees

Native harness agents use ordinary directories directly: chat and other tasks do not require a Git repository. Agents selecting the same ordinary directory share its files. Loop records the agent and directory for the conversation and reuses them across turns, harness switches and restarts. The binding follows the canonical directory path; start a new conversation if you reuse that path for a different project. It does not create Git checkout records for these runs. If the directory becomes part of a Git repository later, start a new conversation to use an isolated worktree; the existing native session is preserved.

For projects inside a Git repository, each native harness agent gets a persistent Git worktree and branch per project on first use. This includes project subdirectories and applies regardless of the prompt. Its conversations reuse that worktree, including uncommitted changes, across turns, harness switches and restarts. Different agents, owners and Loop data directories get separate worktrees. New worktrees fetch and start from remote `main` (the local `main` branch’s upstream when it tracks `main`, otherwise `origin/main`). A local `main` with an `origin` remote also fetches that remote’s `main`. Fetch failures block creation rather than starting from stale code. Without a matching remote, new worktrees use local `main`, or the project’s committed `HEAD` if there is no `main`. The original checkout’s branch, edits and untracked files are preserved and are not copied. Git repositories need an initial commit. Git verification or worktree errors block execution; they never fall back to using the shared project directory.

Worktrees live under the repository’s Git common directory in `loop-agent-worktrees`, with branches named `loop/agent-<identity hash>`. Loop does not automatically remove or merge them. Fresh native-history forks and explicit desktop handoffs prepare a workspace binding before use. Codex forks and resumes select that bound directory; moving other harnesses’ existing native context into a new Git worktree is unsupported, so their Git handoffs ask for a new conversation. Their ordinary-folder handoffs keep the original directory. Import preparation binds the command to its source native history and records the agent identity before creating a checkout. It saves the resulting workspace before a native fork. Failed or concurrent handoffs to the same destination reuse that identity and validate the saved workspace. Choosing a different destination after a failed preparation creates a separate identity. For a session with a workspace binding, a repeated handoff must use its recorded source directory or agent checkout. Completed imports retain their preparation record; repeating a handoff after switching harnesses creates a fresh agent instead of reusing the consumed identity. A fork with an uncertain result retains its recorded workspace and is never automatically repeated. Legacy native sessions without an agent binding, including imported backups, require a new conversation to run; their context and files are preserved. Their read-only history can still be reopened if the original path used an alias or has moved. Missing or mismatched worktrees block execution. API-provider agents do not launch a local harness or have a local checkout.

**Checkout records.** When a native run starts in an agent worktree, Loop records its branch, `HEAD`, a complete binary patch of pre-existing tracked changes (up to 4 MB), and the untracked file names. When the run reaches a terminal state it records the new `HEAD`, commits added or removed since the start, the tracked files changed during the run with line counts, current tracked uncommitted changes, newly untracked file names, a patch stored at capture time (at most 300 KB, shortened on a line boundary and marked), and what the branch's local remote-tracking ref said, with its timestamp (or that Git could not answer); checkout capture never fetches, commits, pushes or reverts. The tracked baseline is reconstructed in a disposable Git directory owned by Loop, so existing staged and unstaged edits are excluded from the run's diff without writing to the repository's index, objects or refs. A baseline that cannot be captured completely records a failure. Untracked contents are not captured; a previously untracked file added to Git during the run appears as a tracked addition. Older observations retain their original cumulative comparison and citation and are labelled historical in the checkout review. A run that ends more than once is recaptured at its latest end; a failed recapture clears the earlier observation rather than redating it. The worktree belongs to the agent rather than the conversation, so other runs active on the same checkout during the interval are listed as overlap; the record brackets an interval and does not claim exclusive authorship. Capture runs asynchronously beside native sessions. Capture commands that inspect the working tree run against a temporary Git directory that Loop owns: a minimal configuration carrying only the object format, the branch's tracking settings and the line-ending and comparison settings, with repository-local exclusions, a copy of the checkout's `HEAD`, index and refs, and the repository's objects attached read-only through alternates. Nothing under the repository's own `.git` directory is read while a command runs, so filters, diff drivers, text conversion, attributes, hooks, promisor remotes and transports configured there cannot execute, whoever changes them and whenever; the directory is removed afterwards and nothing is written back. Attributes are read as usual so line-ending normalisation applies, but the isolated configuration defines no filter or diff driver, so an attribute that names one selects nothing that runs; files whose attributes select a filter (Git LFS, for example) are compared as raw content and marked as such. Capture commands see no other Git configuration: the user's global and the system configuration are disabled (only their line-ending and comparison settings are carried over), inherited `GIT_*` variables are dropped, file-system monitoring, transports, credentials and prompts are disabled, and submodules are never entered. A run that is cancelled or interrupted is observed again a few seconds later, once the harness process has been terminated. Reftable repositories are not supported. The start capture has a twenty-second budget because it precedes dispatch; a slow repository records a failed start rather than delaying the agent. One capture owns a run at a time across the API and worker processes; a request that arrives while one is in flight makes it run again, so the record ends on the latest observation. A recapture replaces that run’s checkout observation with a new id. Runs that end while the host is down are captured by the worker in the background, without delaying dispatch, and labelled as captured late when the run ended more than a minute earlier. The implementation is [run-checkouts.ts](../src/server/run-checkouts.ts); a capture failure is recorded on the run, never raised into its launch.

## Native behavior and billing

Harnesses own their context, tools, configuration and credential homes. Available integrations depend on the native interface; see each harness below. Loop invokes their native protocols and adds pairing, durable work, approvals, files and team communication. It does not take over a live terminal session. Project selection is not shell confinement: native processes have their OS user's access.

| Harness | Default automatic setup | Mid-turn messages |
| --- | --- | --- |
| Codex | Verified native subscription | Live steering |
| Claude Code | Verified native subscription | Live steering |
| Pi | Existing native configuration; provider charges may apply | Live steering |
| OpenCode | Existing native configuration; provider charges may apply | Next-turn queue |
| Antigravity | Existing native sign-in and billing configuration | Next-turn queue |
| Muse Code | Existing native sign-in and billing configuration | Live steering |
| Grok Build | Existing native sign-in and billing configuration | Next-turn queue |
| Custom ACP | Explicit desktop registration | Next-turn queue |

There is no billing fallback after an authentication failure. Model catalogs and effort choices come from native discovery; `native-default` follows the harness default. Account verification and catalog discovery do not submit a model prompt. Installation is not proof of authentication.

Each result shows its recorded input/output token counts at the bottom. Direct Codex reports during a turn; direct Claude Code reports with its turn result, including cached input tokens; Muse Code reports with its turn result. Antigravity reports the completed steps in the current turn. Counts are omitted when no usage was reported; older native turns are not backfilled. These counts measure recorded turn usage, not the subscription's remaining allowance or reset time. Other native harnesses do not yet supply token counts to this display.

Codex async questions appear in **Needs you** with their answer choices while the agent continues working. If native work finishes first, Loop keeps the run waiting for your answer and continues in the same native thread when you submit it. Cancelled or replaced sessions expire these decisions; resuming native history does not reopen old questions.

Codex MCP URL requests show **Open completion page** and **Completed**. Open the page, finish the requested reconnect or browser flow, then select **Completed** to notify Codex. These requests always require an explicit response, including with **Never ask**. Forms requiring field input remain unsupported.

Codex resumes request thread metadata without copying all saved turns into the startup response. Codex retains the full model context and attachments; Loop keeps its persisted conversation display. Reconnecting therefore does not require transferring the entire file-heavy transcript through one protocol message.

Native display output uses a bounded recent window. Loop saves pending progress before rotating that window and shortens oversized text previews; reaching the display limit does not interrupt native work. Saved progress and tool traces remain available, and a final reply is published only after the harness confirms completion.

GitHub file uploads through Codex do not inherit Loop's approval display limit or native frame-size limit. For GitHub tree, blob, file-update and multi-file push confirmations, large file contents become size and SHA-256 summaries in the preview; repository, paths, modes, commit message and other arguments remain visible. This applies to both manual approvals and **Never ask**. Codex retains the original tool call; Loop sends only the decision, without changing or re-uploading the file contents.

With **Never ask**, other authorized tool confirmations can also have their saved preview abbreviated, with its full byte count and SHA-256 recorded. Session-specific permission settings still take precedence. Other decisions that need manual consent or form input retain the full-display limit, and an uncertain answer is never automatically retried.

For an explicit executable, existing billing configuration, native session resume or a custom ACP agent:

```sh
loop codex --billing existing
loop claude --project /absolute/path/to/project
loop pi
loop opencode
loop antigravity
loop muse
loop grok
loop acp --executable /absolute/path/to/agent --acp-arg serve
```

These commands enable the harness in the same running workspace. Executable paths are chosen on the computer, never supplied by browser input. See `loop --help` for options. Native history discovery and explicit forks are available in the app; a fork does not silently transfer native context between harnesses.

## Antigravity

Install [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli) **1.4.9 or newer**. Then choose **Sign in to Antigravity** in **Settings → Provider connections → Harnesses**, or run `agy` on the execution computer. After sign-in, enable Antigravity there or run `loop antigravity` in your project. `loop start --providers antigravity` selects it explicitly. Loop discovers the `agy` executable; it does not install it or offer npm upgrades. Use `agy update` on the computer.

`agy` has no login command, so **Sign in with Google** runs its terminal sign-in under `script` (util-linux or BSD) on the execution computer and chooses Google OAuth. Loop shows Google's authorization page; after you approve, antigravity.google shows a code to paste back into Loop. `agy` saves the credential in its own store and Loop never reads it. The sign-in completes once `agy models` succeeds; a rejected code ends the attempt. If `agy models` already succeeds, sign-in completes without opening the terminal sign-in. Google Cloud project sign-in stays in `agy`.

Loop uses the documented [streaming CLI](https://antigravity.google/docs/cli/headless/) for sequential turns, tool progress and exact conversation resume. Model discovery and session initialization send no model prompt. Saved instructions accompany explicit prompts, and interrupted tasks are never automatically replayed. Slash commands are disabled in Loop prompts to keep text from changing the native session. Token counts use this turn's completed steps, not the conversation's cumulative usage.

Antigravity requires `--billing existing`. Its native account, model and permission settings apply; Loop does not change them or verify a subscription entitlement. Headless mode cannot relay approvals or questions to Loop. Configure needed tool permissions in Antigravity; tools needing interactive approval can be denied by the CLI. The CLI then reports success without an answer; Loop shows that run as a recoverable failure, keeps the conversation open and does not resend the prompt. The adapter does not inject Loop workspace tools, so Agent mail, team delegation and Loop tool integrations are unavailable. Antigravity is not bundled in the Docker images.

Loop supports fresh data directories and same-build peers only. Earlier launch flags, retired Gemini rows and the `claude-code` alias are intentionally unsupported.

## Muse Code

[Muse Code](https://dev.meta.ai/docs/muse-code/) is Meta's coding agent. Install it with Meta's installer (`curl -fsSL https://dev.meta.ai/install.sh | bash`), **1.4.12 or newer**. Then choose **Sign in to Muse Code** in **Settings → Provider connections → Harnesses**, or run `muse login` on the execution computer. After sign-in, enable Muse Code there or run `loop muse` in your project. `loop start --providers muse` limits automatic discovery to Muse Code. Loop does not install the CLI, and Muse's launcher updates itself, so Loop does not offer upgrades for it.

Loop speaks Muse's native MSP protocol over `muse serve`. Sign-in uses MSP's account methods: **Sign in with Meta** shows Meta's device-code page and code, and **Meta API key** hands the key to Muse, which stores it. Muse keeps the credential; Loop never sees a Meta account token. `META_API_KEY` in the workspace environment takes priority over a stored sign-in, as it does in the CLI. Muse stores an API key without checking it, so a wrong key is reported by the first turn.

Account and model checks read MSP `account/read` and `model/list` without creating a session or sending a prompt. Muse keeps its sessions and context; Loop resumes them by session id without copying their history. MSP has no system-instruction field, so the first prompt of a session carries the saved agent instructions; Muse keeps them in that session's context, and a resumed session that already has turns is not sent them again. Earlier user tasks are not replayed. Loop's workspace tools are added to each session as an optional MCP server, so an outage of those tools does not fail the turn. Approval requests offer only this-call choices (**allow** or **deny**); session-wide or saved grants stay in Muse's own interface. Follow-up messages steer the running turn.

Muse Code defaults to `--billing existing`. MSP reports which credential is in effect but not the plan behind it, so `--billing subscription` is rejected. Model and reasoning-effort choices come from Muse's model catalog. Muse is discovered on PATH; the supplied Docker images do not install it.

## Grok Build

[Grok Build](https://x.ai/cli) is xAI's coding agent, run as `grok`. Install it with xAI's installer (`curl -fsSL https://x.ai/cli/install.sh | bash`), **1.0.70 or newer**. Then choose **Sign in to Grok Build** in **Settings → Provider connections → Harnesses**, or run `grok login` on the execution computer. After sign-in, enable Grok Build there or run `loop grok` in your project. `loop start --providers grok` limits automatic discovery to Grok Build. Loop does not install the CLI. Grok updates itself when you run it, so Loop does not offer upgrades for it; run `grok update` to check now.

**Sign in with Grok** runs `grok login --device-auth` and shows xAI's device-code page (`accounts.x.ai`) and code. Grok keeps the credential in its own store (`~/.grok/auth.json`); Loop never sees it. Grok falls back to `XAI_API_KEY` in the workspace environment when it has no stored sign-in.

Loop uses Grok's ACP mode, `grok agent --no-leader stdio`, for native tools, approvals, model selection and conversation resume. `--no-leader` keeps each session in a process Loop owns even if Grok is configured to share a leader process. Loop sets `GROK_DISABLE_AUTOUPDATER=1` for the processes it starts, including the version check, so discovery or a turn never replaces the binary mid-session. Account and model checks create a native session without submitting a model prompt; Grok lists that empty session in its own history. Loop never calls ACP `authenticate`. ACP has no system-instruction field, so prompts carry the saved agent instructions, including any earlier turns carried over from another harness, until a turn in that native session completes; Grok then keeps them in the session's context. A resumed session whose `session/load` replays earlier turns is not sent them again. After a failed or cancelled first turn they are sent again rather than risk losing them. Earlier user tasks are never re-sent as new prompts. Follow-up messages during a turn queue for the next turn. Grok's own permission mode and rules apply first; tool calls it still asks about appear as approvals in Loop.

Grok Build defaults to `--billing existing`: the signed-in Grok account or `XAI_API_KEY` determines usage charges. ACP does not attest the plan behind the credential, so `--billing subscription` is rejected. Model choices come from Grok's session catalog. Grok is discovered on PATH; the supplied Docker images do not install it.

## Cross-harness teams and handoffs

Put agents in the same team to give them a shared roster and communication tools, regardless of harness. `loop_message` sends a durable message; `loop_message_status` checks delivery and replies. `loop_delegate` assigns a task to a teammate. `loop_handoff` sends the next task, a context summary, an optional workspace reference and published file IDs, asking the recipient to acknowledge ownership in the same thread. Repeated tool calls with the same receipt do not duplicate delivery.

A handoff does not transfer a native session, stop the sender's process, copy a checkout, or grant new permissions. The sender should finish its current edits before handing work over. Agents on the same machine can refer to shared paths; across machines, use published files or committed branches. Live input is used only where the harness supports it; other messages queue for the next turn.

## Sign-in and upgrades

Startup failures name the native step that timed out, an exit signal/code, or
a known installation/setup problem directly on the failed run. Loop records
these safe transport facts in its failure trace without exposing native stderr,
credentials or raw provider messages. A startup failure says no prompt was sent;
failures after dispatch retain uncertain-outcome handling and are never replayed
automatically. Older generic failures identify when the specific cause was not
recorded instead of promising further details.

Settings → Provider connections offers native account status, sign-in, model refresh and supported harness upgrades. Each installed harness card shows its computer and installed version, with **Check for updates** and **Upgrade** controls. Opening the page checks releases without installing anything; checks are cached for five minutes per installation. npm installations check their registry’s latest release; native OpenCode checks its published npm release. Homebrew reports its locally known release and refreshes metadata during the explicit upgrade. Native Claude’s updater checks its configured release channel when you upgrade. Self-updating harnesses, custom installations and managed builds show their own update guidance. Upgrade progress and recovery remain visible on the card after reopening the page. Complete the provider flow, then enable/refresh the connection. Native credentials stay with the CLI. Closing the sign-in sheet does not cancel an active attempt; cancelling is explicit. Attempts expire after 15 minutes or a workspace restart. Loop does not replay uncertain sign-in steps or installers.

### OpenCode and Pi model providers

OpenCode and Pi are harnesses; their model providers own the accounts, API keys and billing. In **Settings → Provider connections → Harnesses**, choose **Manage providers** for the installed harness on the selected execution computer. Loop discovers its native providers, authentication methods and configured models. Existing native sign-ins, environment keys and custom provider configuration remain usable. Loop accepts up to 5,000 models from one harness; it refuses a larger catalog with the reported count and keeps the previous model choices.

Choose **Add provider**, select OpenRouter, OpenAI or another native provider, and enter an API key. **Save key and refresh models** passes the key to that harness's authentication interface, then refreshes its connection and model choices without sending a model prompt. You can explicitly select the other installed harness to save the same key there too. Each store is independent; Loop reports success or an unconfirmed result separately for each. The **Loop runtime API** tab configures Loop's own API connections and does not configure either harness.

For provider account sign-in, select the method advertised by the harness and complete its guided flow. A successful sign-in refreshes the model choices automatically. An Anthropic sign-in inside Pi belongs to Pi's provider store; it is separate from the Claude Code CLI account. Provider plan limits and charges still apply. Model discovery reports configured availability, not a verified entitlement to every model.

Pi does not read Loop's requests until its extensions finish starting, so an extension that asks a question at startup (for example the exe.dev integration prompt) blocks it. Loop reports this instead of enabling Pi; run `pi` once in a terminal on the execution computer to answer it, then refresh Pi.

Pi writes credentials through its `ModelRuntime` authentication interface to its agent directory (normally `~/.pi/agent/auth.json`). OpenCode uses its native authentication endpoints and data directory (normally `~/.local/share/opencode/auth.json`). Their directory overrides and credential precedence still apply. Loop does not copy credentials into its connection database or return stored values to the browser. The API-key field accepts literal keys; configure command-based credentials in the harness itself.

Use **Replace credential or reconnect** to change one provider without replacing the others. **Remove saved credential** appears when the native catalog identifies a stored credential; it shows affected agents and removes only that harness's saved credential. OpenCode's catalog identifies stored API keys, while Pi also identifies stored provider sign-ins. Manage credentials whose storage cannot be identified in the harness itself. Removal disables its Loop connection until you review remaining providers and refresh models; an inherited environment or configuration credential may become effective. Credential changes require idle runs and hold queued work until the change finishes. Idle native sessions reopen with their existing context and the updated credentials.

New connections use the harness's provider billing. A previously saved subscription-only restriction stays in force until you explicitly choose **Use provider billing (API charges may apply)**. If a save succeeds but model refresh fails, the credential remains saved and model refresh can be retried. After an unconfirmed credential change, inspect provider status before starting another change; Loop never automatically resubmits the key.

Finish active runs and sign-in before upgrading a harness. Loop uses the installation's package manager without sudo, checks the resulting version, and attempts rollback when supported. An interrupted upgrade stays unconfirmed until its state is checked. Container installations are updated with their image.

## Recovering retired connections

Migration 071 makes direct connections retired by migration 067 eligible for verification again, preserving their IDs, agents, teams, conversation history and native bindings. Local startup verifies saved native registrations before reconnecting them. Server subscription accounts can be checked through Provider connections. Intentionally disconnected accounts remain disconnected. Failed or uncertain work is not automatically replayed.

## Containers and services

For a paired workspace with its own provider home, use `docker compose -f compose.companion.yaml up --build -d`. Its harnesses execute directly inside the container. A container does not inherit your host's native sign-in.

`loop service install` installs per-user application and connection services using the saved project and launch options. `loop restart` replaces the application while the connection service retains its public address and paired devices. `loop service uninstall` removes the services while preserving workspace data. See [pairing](pairing.md).
