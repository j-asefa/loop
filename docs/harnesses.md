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

Worktrees live under the repository’s Git common directory in `loop-agent-worktrees`, with branches named `loop/agent-<identity hash>`. Only checkouts there are resumed; checkouts that pre-release builds left elsewhere (such as `loop55-agent-worktrees`) are not resumed, and their files stay on disk. Loop does not automatically remove or merge them. Fresh native-history forks and explicit desktop handoffs prepare a workspace binding before use. Codex forks and resumes select that bound directory; moving other harnesses’ existing native context into a new Git worktree is unsupported, so their Git handoffs ask for a new conversation. Their ordinary-folder handoffs keep the original directory. Import preparation binds the command to its source native history and records the agent identity before creating a checkout. It saves the resulting workspace before a native fork. Failed or concurrent handoffs to the same destination reuse that identity and validate the saved workspace. Choosing a different destination after a failed preparation creates a separate identity. For a session with a workspace binding, a repeated handoff must use its recorded source directory or agent checkout. Completed imports retain their preparation record; repeating a handoff after switching harnesses creates a fresh agent instead of reusing the consumed identity. A fork with an uncertain result retains its recorded workspace and is never automatically repeated. Every saved session binding records the prepared agent identity. Missing or mismatched worktrees block execution. API-provider agents do not launch a local harness or have a local checkout.

**Checkout records.** When a native run starts and ends in an agent worktree, Loop records what it observed with read-only Git: the branch and `HEAD`, commits added or removed, tracked files changed during the run with line counts, current uncommitted changes, untracked file names, a bounded patch, and what the local remote-tracking ref said. Pre-existing edits are excluded from the run's diff; older, historical observations keep their original cumulative comparison. Capture never fetches, commits, pushes or reverts, and nothing the repository's own Git configuration names (filters, hooks, diff drivers) runs. Untracked file contents are not captured. The worktree belongs to the agent, so other runs active on it during the interval are listed as overlap; the record does not claim exclusive authorship. Older observations are labelled historical in the checkout review. The start capture has a short budget before dispatch; a slow repository records a failed start instead of delaying the agent further, and any capture failure is recorded on the run rather than stopping it. Runs that ended while the host was down are captured later by the worker and labelled as captured late. Limits, the isolated Git directory and recapture rules are in [run-checkouts.ts](../src/server/run-checkouts.ts).

The [harness descriptor](../src/shared/harnesses.ts) owns discovery and policy facts, including activity transport, launch permission support and CLI sign-in commands, domains and response mode. The provider schema is derived from its provider identities plus API providers. The adapter and workspace-tool tables are exhaustive for their descriptor subsets; fixtures tie live steering to the adapter method. `Adapter.capabilities` remains adapter-owned: native discovery persists and returns it, and ACP uses its resume flag during startup.

## Instruction files

Only the root [AGENTS.md](../AGENTS.md) reaches every harness that reads instruction files, so every pattern is reachable from it in one hop. Nested files add pointers for the harnesses that load them. Agents start in the worktree root, or in a project subdirectory of it.

| Harness     | Read at start                                                                                                                                        | Read when a file is touched                                                                                                          | Source                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Claude Code | `CLAUDE.md` and `CLAUDE.local.md` in the launch directory and above; `AGENTS.md` only when neither exists. The root `CLAUDE.md` imports `AGENTS.md`. | A subdirectory's `CLAUDE.md` (Loop's nested ones import the `AGENTS.md` beside them) and `.claude/rules/` files whose `paths:` match | [Claude Code memory docs](https://code.claude.com/docs/en/memory)    |
| Codex       | `AGENTS.md` from the repository root down to the launch directory; not `CLAUDE.md`                                                                   | None                                                                                                                                 | Observation with codex-cli 0.167.0 on 2026-11-16                     |
| Pi          | The first of `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md` in the agent directory and in each ancestor of the project                             | None                                                                                                                                 | [pi-customization-files.ts](../src/server/pi-customization-files.ts) |
| Antigravity | `AGENTS.md` and `GEMINI.md` in the launch directory and above; not `CLAUDE.md`                                                                       | None observed                                                                                                                        | Observation with agy 1.5.9 on 2026-11-16                             |
| OpenCode    | Unverified                                                                                                                                           | Unverified                                                                                                                           | —                                                                    |
| Muse Code   | None observed in `muse exec`                                                                                                                         | None observed                                                                                                                        | Observation with Muse Code 1.4.14 on 2026-11-16                      |
| Grok Build  | None observed in `grok -p`                                                                                                                           | None observed                                                                                                                        | Observation with grok 1.0.70 on 2026-11-16                           |

The observations asked each CLI, in a scratch repository holding marker words in `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and a nested `sub/AGENTS.md`, to list the markers it had been given, from the root and from `sub/`. They describe those versions on one machine, not a vendor contract.

## Native behavior and billing

Harnesses own their context, tools, configuration and credential homes. Available integrations depend on the native interface; see each harness below. Loop invokes their native protocols and adds pairing, durable work, approvals, files and team communication. It does not take over a live terminal session. Project selection is not shell confinement: native processes have their OS user's access.

| Harness     | Default automatic setup                                   | Mid-turn messages                                      |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------ |
| Codex       | Verified native subscription                              | Live steering                                          |
| Claude Code | Verified native subscription                              | Live steering                                          |
| Pi          | Existing native configuration; provider charges may apply | Live steering                                          |
| OpenCode    | Existing native configuration; provider charges may apply | Next-turn queue                                        |
| Antigravity | Existing native sign-in and billing configuration         | Live steering with ACP; older streaming runtimes queue |
| Muse Code   | Existing native sign-in and billing configuration         | Live steering                                          |
| Grok Build  | Existing native sign-in and billing configuration         | Next-turn queue                                        |
| Custom ACP  | Explicit desktop registration                             | Next-turn queue                                        |

`loop pi` also defaults to existing native configuration. Use `--billing subscription` to require a verified Pi subscription for the selected model. OpenCode keeps its interactive consent prompt before using existing provider configuration.

There is no billing fallback after an authentication failure. Model catalogs and effort choices come from native discovery; `native-default` follows the harness default. Account verification and catalog discovery do not submit a model prompt. Installation is not proof of authentication.

Each result shows its recorded input/output token counts at the bottom. Direct Codex reports during a turn; direct Claude Code reports with its turn result, including cached input tokens; Muse Code reports with its turn result. The older Antigravity streaming adapter reports completed-step counts for the current turn; its ACP adapter reports usage supplied in prompt responses. Counts are omitted when no usage was reported; older native turns are not backfilled. These counts measure recorded turn usage, not the subscription's remaining allowance or reset time. Other native harnesses do not yet supply token counts to this display.

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

Install [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli) **1.5.2 or newer**. Then choose **Sign in to Antigravity** in **Settings → Provider connections → Harnesses**, or run `agy` on the execution computer. After sign-in, enable Antigravity there or run `loop antigravity` in your project. `loop start --providers antigravity` selects it explicitly. Loop discovers the `agy` executable; it does not install it or offer npm upgrades. Use `agy update` on the computer.

`agy` has no login command, so **Sign in with Google** runs its terminal sign-in under `script` (util-linux or BSD) on the execution computer and chooses Google OAuth. Loop shows Google's authorization page; after you approve, antigravity.google shows a code to paste back into Loop. `agy` saves the credential in its own store and Loop never reads it. The sign-in completes once `agy models` succeeds; a rejected code ends the attempt. If `agy models` already succeeds, sign-in completes without opening the terminal sign-in. Google Cloud project sign-in stays in `agy`.

With **Antigravity CLI 1.5.9 or newer**, Loop uses the documented [ACP interface](https://antigravity.google/docs/ide/extensions/acp), launched with `agy acp --process-per-session`. Each native session receives its own authenticated Loop MCP connection through ACP session creation or resuming. This enables Agent mail, team delegation and Loop tool integrations without editing global or project MCP configuration. ACP must advertise HTTP MCP support; setup fails before sending a prompt if it does not. Enable Antigravity again after upgrading the CLI so Loop refreshes its saved runtime version and capabilities. Existing streaming sessions switch to ACP on their next turn; refreshing does not interrupt a running turn. See [session reuse](state-machines.md#companion_sessionsstate).

Model discovery and session initialization send no model prompt. Saved instructions accompany explicit prompts, and interrupted tasks are never automatically replayed. Existing native conversation IDs and workspace bindings are retained when a newer runtime resumes a conversation created by the streaming adapter. Commands and skills come from the session’s ACP catalog. Catalog probes and slash-leading prompts or live replies wait up to five seconds for that catalog. A discovered command stays at the start of an explicit prompt, followed by saved instructions; other slash-leading text stays literal, including when discovery times out. Saved instructions starting with `/` also stay literal. The model catalog comes from ACP; if the account no longer offers a previously selected model through that interface, select an available model explicitly. Loop does not choose a replacement model after failure.

Antigravity requires `--billing existing`. Its native sign-in, billing and permission rules apply; Loop does not verify a subscription entitlement. ACP permission requests appear in Loop's approval flow. CLI 1.5.2–1.5.8 uses `agy acp` with approvals and live steering, while Agent mail and team delegation require 1.5.9 or newer. A reply during a running ACP turn uses another `session/prompt`; Loop waits for the original prompt echo, then confirms delivery from an exact reply echo or normal request completion. Replies wait while an approval is open. Unconfirmed replies are not automatically resent. Older streaming runtimes queue follow-ups for the next turn. Antigravity is not bundled in the Docker images.

Saved runtime registrations for versions **1.4.9–1.5.1** keep the [streaming CLI](https://antigravity.google/docs/cli/headless/) adapter and exact native conversation resume. That adapter reads the project’s command catalog through a separate prompt-free ACP session, with a bounded five-second discovery deadline. It cannot inject Loop tools or relay approvals and questions. Agent mail and team delegation remain unavailable until the connection is re-enabled with a newer CLI. Configure permissions in Antigravity for those older runtimes; a tool denied in headless mode can yield an empty successful response, which Loop reports as a recoverable failure without resending the task. Streaming token counts use this turn's completed steps rather than cumulative conversation usage; ACP turns report usage from prompt responses when supplied by the harness.

Loop requires same-build peers. Earlier launch flags, retired Gemini rows and the `claude-code` alias are intentionally unsupported.

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
automatically.

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

## Reconnecting saved connections

Local startup verifies saved native registrations before reconnecting them. Check unavailable harness accounts through Provider connections. Intentionally disconnected accounts remain disconnected. Failed or uncertain work is not automatically replayed.

## Containers and services

For a paired workspace with its own provider home, use `docker compose -f compose.companion.yaml up --build -d`. Its harnesses execute directly inside the container. A container does not inherit your host's native sign-in.

`loop service install` installs per-user application and connection services using the saved project and launch options. `loop restart` replaces the application while the connection service retains its public address and paired devices. `loop service uninstall` removes the services while preserving workspace data. See [pairing](pairing.md).
