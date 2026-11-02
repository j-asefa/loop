# Upgrading to Loop55

The product and npm package are **Loop55** / `loop55`. The commands are
`loop55` and `loop55-job`; environment settings use `LOOP55_*`. The GitHub
repository remains [j-asefa/loop](https://github.com/j-asefa/loop).

## Checkout and npm installations

Finish active runs, then run `bash install` from the checkout. Use `loop55`
after installation. An existing `loop` executable can still refer to an older
build; installing the new command does not remove an unrelated executable.

New workspaces use `~/.local/state/loop55` and `loop55.db`. Startup reuses an
existing `~/.local/state/loop` workspace or `loop.db` rather than creating a
second empty workspace. If both database names or both default workspace
names exist, startup refuses to choose between them. Select the intended
workspace with `LOOP55_HOME` or `LOOP55_DATA_DIR` and resolve the database
ambiguity before starting. Do not rename an open SQLite database or its WAL.
Existing Git worktrees retain their registered paths, branches and native
context; new worktrees use `loop55-agent-worktrees` and `loop55/agent-*`.

`npm run setup` changes existing `.env` setting names from `LOOP_*` to
`LOOP55_*` without generating replacement encryption keys or runtime tokens.
Node entrypoints also accept the old environment names when the corresponding
new name is absent. An explicit `LOOP55_*` value takes precedence. Update
shell profiles, service overrides and external runtime configurations to use
the new names.

New login services are `loop55.service` / `loop55-connection.service` on Linux,
and `dev.loop55.workspace` / `dev.loop55.connection` on macOS. Restart and
upgrade recognize an existing service by its configured workspace home,
including an old service name. To replace its names, finish active runs and
run `loop55 service install`. The installer stops and removes the matching old
units before starting the new ones; this can change the tunnel address. Pair
again with `loop55 pair` if needed.

## Docker installations

The server Compose service is `loop55`. Companion services are
`loop55-companion` and `loop55-connection`. New volume names also use
`loop55`. Before replacing an existing stack, stop its old services using the
old Compose definitions, keep its volumes, and select those existing volumes
explicitly in the new configuration:

| Stack | Setting | Existing volume to select |
| --- | --- | --- |
| Server | `LOOP55_DATA_VOLUME` | The previous project's `loop-data` volume |
| Companion | `LOOP55_COMPANION_DATA_VOLUME` | The previous `loop-companion-data` volume |
| Companion | `LOOP55_COMPANION_PROJECTS_VOLUME` | The previous `loop-companion-projects` volume |
| Companion | `LOOP55_COMPANION_CONNECTION_VOLUME` | The previous `loop-companion-connection` volume |

Use the exact names from `docker volume ls`, including the old Compose project
prefix. Never use `down --volumes` to perform this upgrade. Run
`npm run setup` to migrate `.env`, then start the new stack. The companion
mounts data under `/data/loop55`; an alias retains access to old absolute
provider-home paths. Startup retains the existing database filename.

The optional job queue has new command, configuration and service names too.
Finish or explicitly cancel old queued jobs with the old `loop-job` before
stopping its service and running the queue installer for Loop55. Do not copy
pending task state into a second queue or submit uncertain jobs again. See
[explicit queues](server.md#queue-commands-explicitly).

## Devices and integrations

The app name, home-screen title and new session cookies use Loop55. Existing
paired-device cookies and digest-bound integration credentials remain accepted.
New integration and webhook credentials use `loop55_*` prefixes. Browser draft
and preference keys migrate without overwriting newer values or changing their
owner scopes.

HTTP integration headers now use `x-loop55-*`, MCP workspace tools use
`loop55_*`. Update external clients and upgrade
all linked machines together; old and new header protocols are not a rolling
mixed-version fleet. Native harness sessions retain their own context, so an
older transcript can still contain historical tool names.

The existing connection service’s private probe and socket identity, provider-home Docker volume identities, signed fleet domain separators, dispatch IDs, issued secret bytes and pending
browser command journals retain their original bytes. In particular, the
physical IndexedDB journal and its cross-tab lock namespace are shared with
the old client. These are durable identities rather than new display names;
changing them would invalidate proofs or abandon uncertain effects. The
upgrade does not resend those effects. Released SQL migrations remain
immutable; a new migration updates harness metadata and notification triggers.
