# Loop V0 evidence

Release verification is local integration and labeled deterministic fixtures unless explicitly stated. No live-provider, live-Datadog, deployed or physical-device pass is claimed. Final published commit/tree and CI result are recorded in the PR. Source references and capability decisions: [CAPABILITIES.md](CAPABILITIES.md), [MCP.md](MCP.md), [DEPLOYMENT.md](DEPLOYMENT.md).

| ID | Area | Status | Evidence | Remaining gate |
|---|---|---|---|---|
| A1 | Accounts, ownership, relaunch | Partial | Real maintained-auth signup/logout; API, artifact, app-resource, agent and search isolation; session survives process restart | Installed iPhone relaunch |
| A2 | Provider execution/auth | Partial | Official Codex/Claude Code subscription runtimes; account isolation, native protocol fixtures, selected model/context, both SDK contracts; subscription-first UI | Live user sign-in and allowance-backed inference; optional API live checks |
| A3 | Chat imports | Verified — fixtures | ChatGPT/Claude parsing, branches/roles/timestamps, attachments/original archive, malformed ZIP rejection, dedup/restart; real worker/browser import | Additional exporter variants may require adapters |
| A4 | Provider/account/model UX | Verified — fixtures | Shared creation sheet from composer/feed/share/workflow; preserved drafts; model snapshot + actual SDK request contract | Live inference covered by A2 |
| A5 | Global names/provenance | Verified — local | Two-process cross-user normalized-name race; alias reservation and routing; provider badges/snapshots | — |
| A6 | Product surfaces | Verified — local/fixtures | Full browser journey and phone screenshots; feed pagination, profiles/files/search, contextual conversations, controls, workflow editor, source cards, filing | Live execution gates remain separate |
| A7 | Durable runs/approvals | Verified — fixtures | Separate worker; close client mid-run, recover exact two messages/events; queue ordering, pause, cancellation, stale interruption, approval rejection, 500 approval cycles during concurrent writes, no uncertain-call replay | Real provider interruption behavior remains unverified |
| A8 | Hybrid search | Partial | FTS over 10,000 messages; owner isolation; project/type filters before candidate cap; persisted opt-in embedding/RRF path and keyword fallback | Live paraphrase retrieval needs authorized embedding account |
| A9 | Filing/Undo/autosave | Verified — local | Real natural/direct move + Undo; stale Undo refusal; updated search location; retained source link; auto-saved outputs | — |
| A10 | DSL workflow | Verified — fixtures | Two different provider adapters; second consumes first; immutable versions/bindings; budgets, owner review/rejection, output saved once | Live cross-provider run needs both subscriptions or optional keys |
| A11 | MCP lifecycle/workspace access | Partial | Official SDK discovery; connect/test/disable UI; reconnect/disconnect code; schema/owner/disable/UI-call denial | Remote OAuth and live service lifecycle need an authorized account |
| A12 | Datadog/native charts | Partial | Exact numeric samples/nulls/units/time persisted; native inspector; fixture labeling; authorized refresh | Actual live Datadog MCP response shape must be inspected and mapping verified |
| A13 | MCP Apps/fallbacks | Verified — fixture | Official App + AppBridge handshake; allowed request queues for approval; denied tool/capability, parent DOM blocked; safe JSON fallback | External-asset-dependent apps use documented fallback |
| A14 | Share routing | Verified — browser/fixtures | Deep link only drafts; untagged creation preserves source/question/project; handles resolve or fail; queued behind active work; copy/paste + Shortcut handoff | Actual iPhone Shortcut remains a device check |
| A15 | Themes/responsive UI | Verified — Chromium emulation | 320/390/430/1024 CSS px + landscape; light/dark/system; no page overflow; inspected warm-light/dark screenshots | Software keyboard/physical iPhone check remains |
| A16 | HTTPS/PWA/iPhone | Blocked | Manifest/icons/offline/update code; public-only cache and reconnect tested locally; deployment/installation documented | Persistent Node host, volume and HTTPS hostname/access; actual iPhone; WebKit OS dependencies unavailable |
| A17 | Build/CI/setup | Verified — local and hosted CI | Typecheck + production build; 33 tests including subscription contracts; clean npm ci/setup/build/tests; six migrations/auth migration; both DB integrity checks; production-only boot | Latest exact-commit hosted result and Docker Compose check are recorded in PR; Docker unavailable locally |
| A18 | Open PR | Verified | [Draft PR #1](https://github.com/j-asefa/loop/pull/1), main target, screenshots/evidence/limits | Remains draft for external gates; not merged |

## Phase 1 — foundation

`npm run build`: passed typecheck and Vite production build. `node scripts/smoke-foundation.mjs` against fresh API/worker: passed signup/session, durable run read, idempotency, queued/running/progress/completed worker events, two-user isolation and 401 for anonymous requests. Data is in persistent SQLite and is opened by independent worker/API processes. No live model invocation.

## Phase 2 — core agents

`npm test`: 3 deterministic integration tests passed: cross-user normalized-name collision and alias retention, owner-bound credential encryption/access, exact selected provider model, sequential conversation history, idempotent retry and persisted messages/artifacts. `npm run build`: passed. Both OpenAI Responses and Anthropic Messages streaming adapters are implemented; model catalogs validate connections. Live runs blocked by absent task credentials. Bundled demo opened in Chromium after browser installation fallback; reference screenshot in evidence/demo-reference.png. UI comparison and emulated app checks continue in release. Codex account login remains blocked by missing isolated per-user runtime.

## Phase 3 — durable workspace/history

`npm test`: 9 tests passed, including both representative export formats/ChatGPT alternate branches, zip traversal rejection, import deduplication/restart, attachment preservation, reversible filing/stale-Undo rejection, 10,000-message FTS tenant isolation and stale-worker interruption. See evidence/phase3-tests.txt. `npm run build`: passed. Semantic indexing/query code implemented with explicit opt-in, pending status and keyword fallback; live paraphrase retrieval is BLOCKED without an embedding credential.

`CHROMIUM_PATH=<local chromium> node scripts/browser-smoke.mjs`: PASS at 390×844: real sign-up, export preview, separate worker import completion, feed, folder creation, exact search result, dark preference across reload, no horizontal overflow or browser JS errors. Screenshots evidence/mobile-{empty,feed,dark}.png. Browser emulation is not actual iPhone testing.

## Phase 4 — executable workflows

`npm test`: 12 tests pass. Workflow fixtures exercise an OpenAI-labeled agent → exact owner review → Anthropic-labeled agent consuming the first result → saved artifact, through the actual worker and queue. Tests verify immutable model snapshots, usage limits, idempotent submission, single saved output, rejection propagation, cross-user denial and invalid/cyclic/forward references. These are deterministic adapter fixtures, not live provider evidence. `npm run build`: passed. Source/preview, bindings, input form, version save/run and stage history implemented. OpenProse compatibility decision is in WORKFLOWS.md.

## Phase 5 — MCP and native artifacts

`npm run build`: PASS. `npm test`: 16 tests PASS, including official SDK in-memory client/server discovery, a model → approved MCP call → model response through the worker, exact timeseries/null/unit preservation, persisted app resource, owner/schema/tool denial, grant revocation after approval, unknown-outcome replay prevention and private-network URL rejection. Fixture metrics are explicitly labeled. Connection UI, agent creation tool selection, native chart/data inspector and constrained official Apps bridge are implemented. Browser sandbox interaction remains for release checks. Live Datadog tool/result inspection and remote OAuth are BLOCKED without authorized task credentials; the API-shaped fixture is not live Datadog evidence. See MCP.md for the scope and fallback policy.

## Phase 6 — mobile and sharing

`npm test`: 18 tests PASS, including handle aliases/ownership, unknown-handle errors, idempotent source attribution and routing behind active work. `npm run build`: PASS. Expanded `scripts/browser-smoke.mjs` on a fresh database: PASS signup/import/search/folders, 320/390/430/1024-pixel widths, landscape, light/dark/system theme, share deep link → provider/account/model creation → preserved question/source → route preview, unknown-handle denial, no auto-send, browser back, offline relaunch, public-only Cache Storage and logout cleanup. Screenshots `evidence/mobile-share.png`, `mobile-feed.png`, `mobile-dark.png`. Emulated Chromium, not actual iPhone or WebKit. A timing-sensitive media-query assertion was corrected to await the theme event. Isolated databases avoid polluting auth rate-limit buckets across smoke runs.

Manifest, Apple/maskable icons, safe areas, Shortcut/copy-paste fallback and explicit service-worker updates are implemented. Native iOS Share Target is not claimed. Deployment packaging includes Node API/worker supervision, Docker/Caddy HTTPS, persistent volume, `.env.example`, backup and install instructions. **A16 remains blocked**: no authorized persistent Node host/domain, Docker unavailable locally, and no actual iPhone access. Sites hosting was assessed; its Workers output cannot run this chosen Node/disk worker architecture. See DEPLOYMENT.md for the exact access needed.

## Phase 7 — complete acceptance and fixes

The complete acceptance contract and targeted core/workspace references were reconciled. Fixed: auth WAL writer race (separate maintained-auth database with legacy account migration), atomic migration checks, filtered retrieval before the candidate limit, provider incomplete/token-limit handling, grant/pause boundaries, import pause/failure state, exact source-conversation anchors, contextual composer routing/filing, workflow creation return path, profile Files/scoped search, folder editing, chart gap markers, bounded Apps resources, and public-only health/caching/security headers. See ARCHITECTURE.md and MCP.md.

Commands: `npm run build`, `npm run typecheck`, `npm test` (24 passing tests in seven files). `CHROMIUM_PATH=<installed binary> npm run smoke:browser` and `npm run smoke:journey`: PASS. The second test uses test-only provider/MCP entrypoints and the real SDK/protocol/browser/worker path; it is not a live model or Datadog run. The production process cannot enable test adapters through HTTP. The test fixture explicitly names itself. Screenshot review: light feed, dark search, shared-route draft and native-chart/App sandbox.

A separate clone passed `npm ci`, setup, production build, tests, all six workspace migrations + maintained-auth migration, both database integrity checks, persisted session/completed run after supervisor restart, cross-origin mutation denial, and boot after `npm prune --omit=dev`. The first clean install exposed npm's implicit native rebuild when the lockfile omitted the package's upstream `gypfile:false`; preserving that field fixed a plain `npm ci`. No installed dependency source was patched. Docker remains unavailable, so its container build is not claimed.

WebKit download succeeded; host validation reported missing GTK/GStreamer and related libraries. `playwright install-deps webkit` failed because this environment cannot perform the required setgroups/setuid operations. Automated WebKit and physical iPhone tests are unverified. Chromium emulation passes. No deployment was attempted on a stateless frontend host because that would leave the persistent backend/worker unavailable.

Search scale evidence: 10,000 synthetic messages indexed and retrieved within the 2-second test budget; keyword-only fallback remains functional. Semantic search currently scans the owner's stored vectors in-process and is a single-host V0 limit, not an approximate-nearest-neighbor service. Live paraphrase quality is blocked without an embedding credential. Datadog's API-shaped fixture mapping must not be described as a verified live MCP mapping.

Logs: [unit/contract suite](evidence/final-tests.txt), [release verification](evidence/release-verification.txt). Screenshots: [light](evidence/mobile-feed.png), [dark](evidence/mobile-dark.png), [sharing](evidence/mobile-share.png), [MCP Apps fixture](evidence/mcp-app-fixture.png).

## Published verification

Implementation commit: `409b88893acd902864864e916071c0abf861250c`. Its tree `4c180302e3c09288baaf1f6edc603fbe63797be4` exactly matched the locally tested source. [GitHub Actions run 35816492235](https://github.com/j-asefa/loop/actions/runs/35816492235) **PASSED**, including clean install/setup/build, 24 tests, browser installation and both complete browser journeys. The following evidence/screenshot update changes no application or test source. [PR #1](https://github.com/j-asefa/loop/pull/1) is open as draft against `main`; no merge or auto-merge.


### Hosted-check contention follow-up

The evidence-only repeat run 35816769302 passed installation/build/unit checks and the first browser journey, then failed while awaiting MCP approval in the second journey. A new test with an independent database writer reproduced a `database is locked` failure in queue mutation. Workspace mutation transactions now use `BEGIN IMMEDIATE`, acquiring the write lock before reads instead of trying to upgrade a stale WAL snapshot. This is a locking fix, not automatic replay of model/tool actions. The new test exercises 500 complete approval cycles during concurrent request-counter writes; it failed before the fix and passes after it. The fixture worker retains underlying test exceptions in CI logs. Local verification after the fix: `npm run build`, all 25 tests in seven files, and the full fixture browser journey passed. Final source commit and hosted result are recorded in PR #1.


## Subscription runtime rebuild

Implemented isolated official Codex and Claude Code 2.1.280 runtimes, subscription-first sign-in, per-connection credential volumes, explicit optional API connections and no automatic API fallback. Compose now starts on localhost without a domain; HTTPS is an optional profile. See [SUBSCRIPTIONS.md](SUBSCRIPTIONS.md).

Local verification: production build and all 33 tests in eight files pass. Eight native-protocol contract tests invoke the actual runtime wrapper with controlled CLI fixtures, covering authentication, environment scrubbing, model access, structured answers/tool calls, quota failure and container isolation arguments. The complete browser/worker journey passes both sign-in flows, saved subscription answers, cross-user denial, disconnect and a subscription-backed MCP call through the existing approval boundary. These authenticated flows use explicit test fixtures, not real accounts. Both installed, unmodified native CLIs were also exercised unsigned and correctly reported no authenticated subscription.

The CI container job builds the production images, starts the default no-domain stack, creates a real Loop session and checks unsigned status through the private broker and both real native CLIs. Its exact published result is recorded in PR #1. Live subscription sign-in/inference and actual allowance consumption still require the user's own account. No live success or token-by-token subscription streaming is claimed: native structured output is validated before emitting the answer.


## Codex 0.157.0 pin update — 2026-09-26

The native Codex compatibility pin, runtime image, and protocol test fixture now target 0.157.0. The official npm package reports `codex-cli 0.157.0`; its generated experimental App Server schema includes the initialize, account/model, and thread methods used by Loop. No authenticated account, model request, or subscription usage was exercised for this version. Hosted CI remains the integration gate.
