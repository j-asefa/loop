# Harnesses and laptop execution

Build and optionally link the CLI as described in the [README](../README.md). Commands here use `loop`; `node dist/cli.js` is equivalent from the checkout. Use `loop --help` for the complete option list.

## Direct harnesses

Install the harness and complete its native sign-in first. Loop discovers it on PATH or accepts `--executable PATH`. Direct adapters do not install or upgrade harnesses. `loop doctor --json` reports discovery and version compatibility.

Run `loop start` in a project directory to start and pair the workspace before selecting a harness. In **New agent → Choose or enable a runtime on this computer**, choose the bound project and billing policy, enable the installed harness, then select its connection and model. `loop start` returns after startup; `loop pair` issues a fresh code for the running workspace. Runtime-specific commands below remain available as shortcuts. See [start and runtime selection](companion/START-PAIR.md) for behavior and compatibility.

| Command                                                            | Transport                             | Billing behavior                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `loop codex`                                                       | Codex App Server                      | Default subscription mode requires ChatGPT login and the built-in OpenAI provider; no API fallback |
| `loop pi`                                                          | Pi RPC with a process-local extension | Subscription mode requires effective OAuth metadata and a subscription declaration                 |
| `loop claude --billing existing`                                   | Claude bidirectional stream JSON      | Explicit API/provider configuration; direct Claude.ai login is blocked by this adapter             |
| `loop opencode --billing existing`                                 | Local authenticated HTTP/SSE          | Existing-provider mode; subscription billing cannot be established from native metadata            |
| `loop acp --executable /absolute/path/to/agent --billing existing` | Local ACP v1 subprocess               | The agent owns authentication and billing                                                          |

Direct version checks are defined in [src/host-control.ts](../src/host-control.ts): Codex 0.157.0, Claude 2.1.282, Pi 0.87.1 and OpenCode 1.18.32. Managed image pins live separately in [deployment/versions.json](../deployment/versions.json); do not substitute one policy or version set for the other.

Pass `--project /absolute/path/to/project` to choose a directory. New conversations bind their original connection, directory and native session. Later changes to an agent's settings do not move an existing native conversation. Multiple invocations enable harnesses in the same workspace. `--foreground` keeps the host attached to the terminal; otherwise it runs in the background. See [pairing](pairing.md) for connection, status and stop commands.

Harnesses retain their own tools, permissions, instructions, skills and plugins. Loop tools are supplied through a private per-generation MCP bridge (Pi uses its extension). Catalog support varies by harness. Workflows can bound native steps and elapsed time, but cannot enforce the harness's internal model-call/token counts. Native work can be cancelled, not paused mid-turn.

Saved Codex history supports read/fork and follow-ups to managed conversations. `loop codex --resume NATIVE_ID` is an explicit handoff after stopping the original owner and workspace; it is not takeover of an arbitrary live desktop process.

## ACP

The absolute executable must exist and be executable. Repeat `--acp-arg ARG` for agent arguments. The first executable/arguments are pinned to the workspace's `native-acp` connection; the browser cannot choose executable paths. Registration probes `initialize` only. Session creation/loading happens when a conversation starts.

The adapter uses the pinned SDK in [package.json](../package.json). Resume requires advertised `session/load`; failed loading never creates a replacement session. Commands are discovered from a live session's `available_commands_update`, not registration. Setting changes wait for agent confirmation. Only advertised one-shot permission choices are exposed.

Loop advertises neither ACP filesystem nor terminal host methods. Agents may still execute their own local tools: ACP is not a sandbox. HTTP MCP tools are offered only when the agent advertises that transport. Protocol fixtures cover the Loop boundary; a particular executable still needs authenticated prompt, cancel, permission, tool and resume validation. Pi RPC is not ACP.

## Managed launcher

Plain `loop` provisions the managed laptop environment using HAPI. It requires Node 24, Git and OpenSSL; Docker execution also requires Docker. The initial build downloads pinned HAPI/Bun inputs. Missing selected provider CLIs are installed in Loop's private helper directory; existing host installations are retained.

```sh
loop --providers both --execution both --project /absolute/path/to/project
```

Provider choices are `openai`, `anthropic`, `both`; execution choices are `native`, `docker`, `both`. Interactive first launch asks for these choices; noninteractive defaults are both providers and native execution. Preferences persist under `LOOP_HOME`. Stop the workspace before changing execution configuration.

In Settings → Execution environments, complete sign-in, then create an agent choosing provider, Run on, model and project. Native runners use your OS identity and project access. Docker runners use separate provider homes and mount the selected project at `/workspaces/project`; they receive neither the host Docker socket nor host provider credentials. Model inference still occurs at the provider.

The managed Codex path enforces ChatGPT authentication without API fallback. Managed Claude uses its own native authentication policy. The direct Claude adapter restrictions above are separate. The [architecture guide](architecture.md) explains dispatch and recovery boundaries.

For startup at login after configuration:

```sh
loop service install
loop pair
```

This installs a per-user launchd agent on macOS or systemd service on Linux using the current Node/CLI/PATH and project. Use `loop service uninstall` to stop/remove it while retaining workspace data; a service may restart a workspace stopped with `loop stop`.
