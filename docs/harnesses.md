# Harnesses and HAPI execution

Build and optionally link the CLI as described in the [README](../README.md). Run `loop` or `loop start` in a project directory. Every harness task runs through HAPI; there are no `loop codex|claude|pi|opencode|acp` commands, `--direct` mode, or direct-execution fallback. API-key agents use Loop's provider API runtime and do not launch a harness.

## Discovery and existing sign-in

Loop discovers Codex, Claude Code, OpenCode and Pi on PATH, checks their versions, and registers available selected harnesses with its HAPI runner. Missing or unsupported installations are reported and are not installed automatically. `loop doctor --json` shows installation checks without making a model request. Restart Loop after installing a new harness.

The native runner runs as your OS user, preserves native credential homes and uses existing sign-in. It verifies the account before enabling a connection and again before dispatch. This is reuse of the account, not takeover of a live terminal conversation. Docker runners have their own credential homes and need sign-in in that environment. Credentials remain on the runner and are never returned to the browser.

| Harness | Managed account policy |
| --- | --- |
| Codex | ChatGPT authentication and the built-in OpenAI provider; no API fallback |
| Claude Code | Verified native Claude account and first-party provider |
| OpenCode | Native ChatGPT OAuth and Loop's guarded build; no API fallback |
| Pi | Existing native provider configuration; provider charges may apply |

Installed does not mean authenticated. If verification fails, check **Settings → Execution environments → Check installation and sign-in**. In **New agent → Choose or enable a runtime on this computer**, select the project and enable the HAPI connection. Provider connections exposes the same local runner. An unavailable HAPI runner never enables a direct adapter.

Discovery minimums are owned by [host-control.ts](../src/host-control.ts): Codex 0.157.0, Claude Code 2.1.237, Pi 0.87.1 and OpenCode 1.18.32. Stable releases at or above those floors are admitted; startup still validates the account and runtime contract. Pins in [deployment/versions.json](../deployment/versions.json) and [deployment/native](../deployment/native/) are reproducible build inputs, not an upper version limit. The guarded OpenCode binary is managed separately from the user's PATH installation.

## Models and effort

Model catalogs come from the runner's provider discovery. Claude Code's initialization response supplies model IDs, display names and supported effort levels; Loop does not substitute a fixed list of family names. Initialization does not submit a model prompt. The native-default option follows the harness default and has no inferred effort choices. Claude, Codex, OpenCode and Pi model and effort selections are sent through HAPI before the turn is dispatched. Unsupported choices are not silently substituted.

## Conversations and permissions

HAPI owns native context, tools and session lifecycle. Loop stores display history, dispatch receipts and approval decisions. Each conversation keeps its original connection, project and native session; changing an agent does not move an existing conversation. Follow-up messages queue for the next HAPI turn.

**Tools & permissions → Agent tool calls → Never ask** automatically answers new HAPI tool approvals using the run's saved preference. Human questions and plan reviews still require an answer. Decisions already waiting remain pending. Automatic answers are recorded before delivery; an uncertain answer is not automatically retried, and the session must be reconciled to establish its outcome.

Migration 067 permanently disconnects older direct and subscription connections on upgrade. Finish or cancel work on those connections before upgrading. Queued legacy runs are not dispatched: the worker marks them failed with a visible “requires HAPI” error in their conversation and Feed. Already accepted or uncertain native work is never replayed. Downgrading the executable does not reconnect these connections; restoring the pre-upgrade database from a backup is the rollback path. Their conversations and native history are preserved, but cannot execute through a direct adapter. Select the corresponding HAPI connection and start a new conversation. Loop does not automatically migrate native context, take over a live CLI/Desktop session, or resend accepted or uncertain work. Desktop-history discovery/fork and arbitrary ACP executables are no longer execution entry points.

## Provider sign-in

Loop tries existing native sign-in before asking for a new login. If needed, open **Settings → Execution environments**, select the runner and runtime, and choose **Manage sign-in**. Complete the provider flow, then **Use in Loop** to verify the account and refresh models. Closing the form leaves an active attempt available to resume; **Cancel sign-in** cancels it. A login link alone is not proof of a connected account.

Use device/headless authentication when the provider offers it for a phone; localhost callback flows may require the computer's browser. Sign-in attempts expire after 15 minutes or a workspace restart. Loop never restarts a login automatically or replays an uncertain submitted step. Signing in does not change billing policy.

## Managed launcher

```sh
loop
loop start --providers codex,claude,pi --execution native
loop start --providers both --execution both --project /absolute/path/to/project
```

The default provider selection is `installed`, which discovers all four supported harnesses; explicit lists and saved selections can limit it. `openai` selects Codex, `anthropic` selects Claude, and `both` selects Codex and Claude. Execution is `native`, `docker` or `both`, defaulting to native. Docker uses the image's installed harnesses and a separate account store. The Docker companion supports native execution inside its container.

Startup requires Node 24, Git and OpenSSL; Docker execution also requires Docker. Pairing and the workspace are available during preparation. If preparation or runner startup fails, Loop cleans up managed resources and reports failed setup. Execution remains unavailable until HAPI is repaired and Loop restarted. It never switches to direct execution. See [start and pairing](companion/START-PAIR.md).

Native runners use the OS user's project access. Docker runners mount the approved project at `/workspaces/project` and receive neither the host Docker socket nor host provider credentials. Project selection is not shell confinement. Existing provider sign-in remains owned by the selected runner.

## Upgrade installed harnesses

**Settings → Execution environments → Check installation and sign-in** offers upgrades for supported installations. The local runtime controls offer the same runner-scoped action. Loop uses the installation's package manager without sudo. Finish or cancel active runs and sign-in before upgrading. An operation has a durable identity; repeated requests return its recorded outcome.

A successful upgrade must pass its version check. A failed upgrade attempts rollback to the previous version where the package manager supports it. A timed-out or interrupted operation remains unconfirmed and holds that runtime until the user checks remaining installer processes and confirms recovery. Loop never resumes an interrupted installer automatically.

Managed Codex requires a workspace restart after upgrade to replace its shared app-server. Guarded OpenCode and container runtimes are updated with Loop or the corresponding image. See [development](development.md) for fixture versus live-provider validation.

## Startup at login

```sh
loop service install
loop service uninstall
```

This installs two per-user launchd agents on macOS (`dev.loop.connection`, `dev.loop.workspace`) or systemd units on Linux (`loop-connection.service`, `loop.service`) using the current Node/CLI/PATH and the workspace's last launch (project, providers, execution and tunnel settings), as `loop restart` repeats it. A local-only or `--public-url` workspace gets only the application unit. The [connection service](pairing.md#connection-service-one-address-across-restarts) owns cloudflared in its own unit, so restarting the application unit (`loop restart`, `systemctl --user restart loop.service` or `launchctl kickstart -k gui/$(id -u)/dev.loop.workspace`) keeps the address and paired devices. Both restart only after a failure, so `loop stop` stays stopped until the next login or until you start the services again (`systemctl --user start loop-connection.service loop.service`, or `loop service install` on macOS). Installing replaces the running workspace and any earlier single-unit service, which changes the Quick Tunnel address once. Use `loop service uninstall` to stop and remove both while retaining workspace data.

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
startup selects this guarded build when an installed OpenCode is selected. Managed
OpenCode requires native ChatGPT OAuth and executing-process guard evidence;
incompatible configuration fails closed before model dispatch.
The companion image bakes the same private artifact into `/opt/loop-opencode`.
Startup verifies its package identity and binary checksum using the host-owned
`LOOP_BAKED_OPENCODE` path, and fails if that configured artifact is missing or
changed. This avoids compiling OpenCode in the persistent provider home. Cache
verification does not replace the executing process's policy attestation.
