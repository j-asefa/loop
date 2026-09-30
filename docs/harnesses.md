# Harnesses and laptop execution

Build and optionally link the CLI as described in the [README](../README.md). Commands here use `loop`; `node dist/cli.js` is equivalent from the checkout. Use `loop --help` for the complete option list.

## Direct harnesses

Install the harness on your computer. Complete its provider sign-in in Loop or in the native CLI. Loop discovers it on PATH or accepts `--executable PATH`. Direct adapters do not install or upgrade harnesses. `loop doctor --json` reports discovery and version compatibility.

Run `loop start` in a project directory to start and pair the workspace before selecting a harness. In **New agent → Choose or enable a runtime on this computer**, choose the bound project and billing policy, enable the installed harness, then select its connection and model. `loop start` returns after startup; `loop pair` issues a fresh code for the running workspace. Runtime-specific commands below remain available as shortcuts. See [start and runtime selection](companion/START-PAIR.md) for behavior and compatibility.

| Command                                                            | Transport                             | Billing behavior                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `loop codex`                                                       | Codex App Server                      | Default subscription mode requires ChatGPT login and the built-in OpenAI provider; no API fallback                                     |
| `loop pi`                                                          | Pi RPC with a process-local extension | Subscription mode requires effective OAuth metadata and a subscription declaration                                                     |
| `loop claude`                                                      | Claude bidirectional stream JSON      | Subscription mode requires verified native Claude login and the first-party provider; existing mode permits explicit API configuration |
| `loop opencode --billing existing`                                 | Local authenticated HTTP/SSE          | Existing-provider mode; subscription billing cannot be established from native metadata                                                |
| `loop acp --executable /absolute/path/to/agent --billing existing` | Local ACP v1 subprocess               | The agent owns authentication and billing                                                                                              |

Direct version checks in [src/host-control.ts](../src/host-control.ts) accept stable releases at or above these minimums, with no upper version cap:

| Harness     | Minimum version |
| ----------- | --------------- |
| Codex       | 0.157.0         |
| Claude Code | 2.1.237         |
| Pi          | 0.87.1          |
| OpenCode    | 1.18.32         |

This includes the latest stable releases and future updates without requiring a Loop release for each version. Prereleases, unreadable versions and older releases are rejected with installation guidance. Version admission does not certify every future release: adapter startup still checks its protocol and account/billing requirements. Loop does not upgrade installed harnesses. ACP uses protocol negotiation instead of a CLI version floor.

Managed image pins in [deployment/versions.json](../deployment/versions.json) and the helper lockfile in [deployment/native](../deployment/native/) remain reproducible build inputs, separate from these compatibility ranges. The managed laptop launcher retains installed provider CLIs rather than replacing them with its bundled versions.

Pi's subscription model catalog includes only routes whose effective OAuth metadata declares subscription support. API routes for the same named model are omitted; existing-provider mode retains them. New agent creation refreshes native model choices before submission, including catalogs saved by an older Loop version. Existing agents keep their saved selection: use the model picker to change an incompatible route before sending again. A stale agent selection that conflicts with this policy fails before dispatch with setup guidance. This metadata check does not guarantee included allowance: a provider can still require usage credits for a third-party client, as described in [Anthropic's authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account).

Pass `--project /absolute/path/to/project` to choose a directory. New conversations bind their original connection, directory and native session. Later changes to an agent's settings do not move an existing native conversation. Multiple invocations enable harnesses in the same workspace. `--foreground` keeps the host attached to the terminal; otherwise it runs in the background. See [pairing](pairing.md) for connection, status and stop commands.

Harnesses retain their own tools, permissions, instructions, skills and plugins. Loop tools are supplied through a private per-generation MCP bridge (Pi uses its extension). Catalog support varies by harness. Workflows can bound native steps and elapsed time, but cannot enforce the harness's internal model-call/token counts. Native work can be cancelled, not paused mid-turn.

Saved Codex desktop history read/fork and `loop codex --resume NATIVE_ID` retain the direct Codex adapter even when HAPI is the default. History discovery and forks require an enabled direct Codex connection; existing direct connections are preserved. The resume command is an explicit handoff after stopping the original owner and workspace; it is not takeover of an arbitrary live desktop process. Arbitrary `loop acp` executables also retain the direct ACP adapter.

## Provider sign-in

Direct runtime setup and Settings → Execution environments use the same sign-in form. In environment settings, choose the environment and runtime, open **Manage sign-in**, complete the provider flow, then **Verify connection**. The account stays in the selected runner’s native credential store. Closing the form leaves an active attempt available to resume; **Cancel sign-in** cancels it.

In a paired native workspace, open **Settings → Provider connections → Connected harnesses**, or expand the runtime controls in **New agent**. Choose **Sign in** beside an installed, supported harness, select its provider and sign-in method, and start sign-in. Open the provider link in your phone's browser and return to Loop; enter a verification code or API key when requested. After success, the panel shows **Signed in** with an **Enable** (or **Refresh**) button to load the harness's models. **Manage account** lets you change accounts later.

Codex uses its device-code login. Claude Code uses `claude auth login` with the selected Claude or Console account. Pi exposes its installed SDK's provider login methods through a dedicated extension. OpenCode exposes its native provider authentication methods through a private local server. For cross-device OAuth, choose a device/headless method when a provider offers one; methods that require a browser callback to the computer's localhost still require that computer's browser. ACP authentication remains owned by its executable.

Closing the panel leaves an unfinished sign-in available when reopened. Cancel stops the dedicated sign-in process; attempts expire after 15 minutes or a workspace restart. Loop never restarts a login automatically or replays a submitted verification step. Sign-in makes no model request. Credentials are saved by the harness in its native store on the computer; Loop does not put them into workspace messages, traces or events. Only paired devices can access these controls.

Signing in does not change an enabled runtime's billing policy. Native Claude Code subscription verification uses the CLI's account status and initialized provider; conflicting API configuration still blocks subscription mode. This native CLI route is covered by [Anthropic's Claude Agent SDK and `claude -p` guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Pi's Anthropic login instead requires separately billed extra usage and does not establish access to the included Claude plan allowance. API-key methods require explicitly choosing existing-provider billing. Loop never switches billing methods after a failure.

## ACP

The absolute executable must exist and be executable. Repeat `--acp-arg ARG` for agent arguments. The first executable/arguments are pinned to the workspace's `native-acp` connection; the browser cannot choose executable paths. Registration probes `initialize` only. Session creation/loading happens when a conversation starts.

The adapter uses the pinned SDK in [package.json](../package.json). Resume requires advertised `session/load`; failed loading never creates a replacement session. Commands are discovered from a live session's `available_commands_update`, not registration. Setting changes wait for agent confirmation. Only advertised one-shot permission choices are exposed.

Loop advertises neither ACP filesystem nor terminal host methods. Agents may still execute their own local tools: ACP is not a sandbox. HTTP MCP tools are offered only when the agent advertises that transport. Protocol fixtures cover the Loop boundary; a particular executable still needs authenticated prompt, cancel, permission, tool and resume validation. Pi RPC is not ACP.

## Managed launcher

`loop start` without runtime preferences prepares one native HAPI runner for Codex, Claude Code, OpenCode and Pi. The automatic choice is not saved as a provider or execution preference. Use `loop start --direct` to use installed direct adapters without managed preparation; this also bypasses saved managed choices for that invocation. Explicit provider/execution options and saved choices retain their existing meaning. That setup requires Node 24, Git and OpenSSL; Docker execution also requires Docker. The workspace and pairing are available while managed execution prepares. Runtime setup shows preparation and runner startup progress and refreshes automatically. If preparation or startup fails, Loop reports the failed stage once and retains direct execution after managed resources are cleaned up. The initial build downloads pinned HAPI/Bun inputs. Missing selected provider CLIs are installed in Loop's private helper directory; existing host installations are retained.

```sh
loop start --providers both --execution both --project /absolute/path/to/project
```

Provider choices are `openai`, `anthropic`, `both`, or a comma-separated list of `codex`, `claude`, `opencode`, `pi`. The legacy `both` alias keeps selecting Codex and Claude. Execution choices are `native`, `docker`, `both`. If you provide only one choice on an interactive terminal, Loop asks for the other; noninteractive startup defaults to both providers and native execution. Preferences persist under `LOOP_HOME`. Stop the workspace before changing execution configuration.

In Settings → Execution environments, complete sign-in, then create an agent choosing provider, Run on, model and project. Native runners use your OS identity and project access. Docker runners use separate provider homes and mount the selected project at `/workspaces/project`; they receive neither the host Docker socket nor host provider credentials. Model inference still occurs at the provider.

The managed Codex path enforces ChatGPT authentication without API fallback. Managed Claude uses its own native authentication policy. The direct adapter checks above remain separate. The [architecture guide](architecture.md) explains dispatch and recovery boundaries.

For startup at login after configuration:

```sh
loop service install
loop pair
```

This installs a per-user launchd agent on macOS or systemd service on Linux using the current Node/CLI/PATH and project. Use `loop service uninstall` to stop/remove it while retaining workspace data; a service may restart a workspace stopped with `loop stop`.

Settings → Execution environments and New agent share managed runtime status cards. “Check installation and sign-in” checks the configured executable and native account on that runner; it does not use pinned version numbers as installation evidence. Failed account checks remain unknown. Billing text describes the required launch policy, not proof of an active subscription. Results are timestamped snapshots; launch still validates authentication.

The managed OpenCode execution guard is built against the exact source commit
and Bun version in `deployment/versions.json`. For a dedicated source checkout,
run `node native/build-opencode.mjs SOURCE ABSOLUTE_BUN_PATH`. The builder applies
the guard, installs frozen dependencies without lifecycle scripts, and builds
one host binary sequentially. `--skip-install` reuses an already prepared checkout.
It uses the checksum-verified `native/opencode-models.json.gz` catalog (from
[models.dev](https://models.dev/api.json)), rather than downloading a changing
catalog during compilation. Updating that catalog requires updating its checksum
and revalidating native routing. The native runner image builds this guarded binary in a separate stage with
its audited Bun version, and retains the upstream license, source archive and
patch. It uses the runner’s native credential home. For a private laptop build, run `node native/provision-opencode.mjs LOOP_HOME`.
The installer retains source and the license, verifies cached binary integrity,
and never replaces an installed CLI or redirects its credential home. Managed
startup selects this guarded build for explicit OpenCode selections. Managed
OpenCode requires native ChatGPT OAuth and executing-process guard evidence;
incompatible configuration fails closed before model dispatch.
The companion image bakes the same private artifact into `/opt/loop-opencode`.
Startup verifies its package identity and binary checksum using the host-owned
`LOOP_BAKED_OPENCODE` path, and fails if that configured artifact is missing or
changed. This avoids compiling OpenCode in the persistent provider home. Cache
verification does not replace the executing process's policy attestation.
