# Prompt: standalone Loop CLI + mobile app with self-updating pairing

Paste this whole file to Opus as the first message of a fresh session, in this
repository, on a branch cut from the current one. The other files in this
directory (`01-*.md` through `06-*.md`) are supporting spec documents —
**read them progressively, one at a time, only when the phase they cover
starts**, not all up front. Each one tells you when to move to the next.

## Mission

Today `loop` is a CLI that runs Codex/Claude/Pi/OpenCode locally and exposes
them to a paired phone through a Cloudflare Quick Tunnel and an installed PWA.
Two things are wrong for daily use:

1. **The command surface is not what it should be.** Running `loop` with no
   arguments should always launch the full Loop server (today that's
   `loop server`; bare `loop` currently does something else — see
   `01-current-architecture.md`). Running `loop <harness>` (`loop codex`,
   `loop claude`, `loop pi`, `loop opencode`) should put up the pairing
   screen and then run that harness **in the background**, handing the
   terminal back — today it runs in the foreground and blocks the terminal
   until you Ctrl-C it.
2. **Pairing dies every time the tunnel URL rotates.** Quick Tunnel URLs are
   anonymous and change on every restart (and on every reconnect after a
   drop). The phone's home-screen icon is a PWA installed at that exact
   origin, so a rotated URL means: open the terminal, find the new
   `https://something.trycloudflare.com` link, open it in Safari, Add to
   Home Screen again, throw away the old icon. This must stop. The user
   should install one app, once, keep its icon forever, and reconnect it
   with a single in-app QR scan — the existing `loop pair` command already
   shows the right code, the app just needs to scan it in-app and reload
   itself pointed at the new origin, instead of the browser/Add-to-Home-
   Screen dance it requires today. No new CLI command, no automatic
   background discovery, no relay, no extra hosted infrastructure — this is
   a resolved design decision, not something to redesign.

You are building both, end to end: the CLI/daemonization changes, the
server-side auth changes that let an installed app's credentials survive a
re-pair cleanly, and the standalone app itself.

## Ground rules

- This is a real, shipped CLI with existing tests (`npm test`,
  `npm run test:native`, `npm run check`) and existing users of the current
  `loop server` / `loop pair` / `loop status` / `loop devices` / `loop stop`
  commands documented in `docs/companion/CLI.md`. Don't break them silently —
  either keep them working as aliases/subcommands or update every doc and
  test that references the old behavior. Read `docs/companion/CLI.md`,
  `docs/UNIFIED-LOOP.md`, and `README.md` before changing CLI semantics, and
  update them as part of the same change.
- No API fallback and no silent billing changes: the existing rule that Loop
  never falls back from subscription billing to API billing is load-bearing
  product behavior, not incidental code. Do not touch `src/host-control.ts`'s
  billing prompts or `src/adapters/*` billing logic except where a phase
  below explicitly requires it.
- Security posture matters more than convenience here: this tool hands a
  phone control of someone's desktop and native agent sessions. Reconnection
  after a tunnel rotation is deliberately a *manual, in-person* action (the
  user runs `loop pair` on their own laptop and scans the code with their
  own phone) specifically so there's no automatic remote-discovery channel
  that could be abused to redirect a paired phone to an attacker-controlled
  origin. Don't reintroduce automatic background discovery as an
  optimization, and don't add a separate `loop sync` command either — both
  were considered and deliberately cut; see `03-resync.md`.
- Prefer extending the existing SQLite-backed, single-binary, account-free
  design over introducing new required hosted infrastructure. This feature
  should add no hosted service of any kind — everything runs on the user's
  own machine plus whatever app store/build tooling the standalone app needs.
- Work in phases, in the order the files are numbered. After each phase:
  run the relevant checks (`npm run check`, `npm test`, `npm run test:native`
  as applicable), commit, and only then read the next numbered file. Don't
  read ahead — later files assume decisions recorded as "confirmed" in
  earlier ones and may otherwise bias you toward a design before you've
  earned the context for it.
- The two design checkpoints an earlier draft of this spec left open (how
  the app rediscovers a rotated tunnel; what tech/distribution the
  standalone app uses) are both **already resolved** — see `03-resync.md`
  and `04-standalone-app.md`. Don't re-litigate them or re-ask the user; if
  you hit a genuinely new decision of similar weight that isn't covered
  anywhere in these files, stop and ask instead of guessing.

## Reading order

1. `01-current-architecture.md` — what exists today and exactly where
   (files, functions, line numbers as of this writing — verify against the
   live code, it may have moved). Skim this before touching anything.
2. `02-cli-command-redesign.md` — the new `loop` / `loop <harness>` command
   semantics and the daemonization work they require. Implement and land
   this phase first; it's useful on its own even before the sync/app work.
3. `03-resync.md` — reusing `loop pair` (no new command) and how the app
   handles a scan of it to reconnect after a tunnel rotation.
4. `04-standalone-app.md` — the actual "standalone mobile app" (not an
   installed-per-origin PWA). Tech/distribution choices are already decided.
5. `05-server-auth-changes.md` — the server/`Host` changes both phase 3 and
   phase 4 depend on (portable device credentials that don't rely on
   cookies). Read this alongside phase 3/4, not before — it's referenced by
   both.
6. `06-plan-and-acceptance.md` — suggested sequencing across multiple PRs
   and the acceptance checklist to hold the whole feature to.

Start by reading `01-current-architecture.md`.
