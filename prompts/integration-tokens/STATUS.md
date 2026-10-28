# Status ledger

Update after every meaningful step. A fresh session must be able to resume from "Next step" alone. Record dates as absolute dates.

| PR | State | Branch | PR URL | Review passes | Reviewed head | Next step |
| --- | --- | --- | --- | --- | --- | --- |
| 1 integration tokens with scopes, reads | ready to merge | tokens/01-integration-tokens | https://github.com/j-asefa/loop/pull/252 | 2 | ef4e7ecf2b7430565e686e55c68b185c05b24214 | Pass 2 completed with all three reviewers and no confirmed findings. Commit this ledger-only update, run npm run check on that submitted head, fetch main, resolve any merge conflict under the process, then squash #252 with the exact head pin. |
| 2 request identity, writes open | todo | | | 0 | | After PR 1 merges |
| 3 token reads of the event stream | todo | | | 0 | | After PR 2 merges |
| 4 outbound webhooks, one event kind | todo | | | 0 | | After PR 3 merges |

States: todo, in progress, checks green, review requested, fixing findings, ready to merge, merged, blocked.

## Scope catalog

| Admission | Admitted contracts after PR 1 |
| --- | --- |
| `read` | `bootstrap`; `agentDetail`, `agentMessages`, `agentTraces`, `agentTracesExport`; `feed`, `feedAway`; `conversation`; `messageSearch`, `messageDetail`; `runs`; `approvals`; `nativeDecisions` (companion only); `results`, `resultUpdates`; `artifactList`, `artifactDetail`, `artifactFile`, `artifactDownload`; `objectFile`; `cardList`, `cardChanges`, `cardDetail` |
| `write` | None until PR 2 provides request identity |
| `approvals:decide` | None until PR 2 provides request identity |
| `results:read` (legacy) | The three Cards reads, Results selection only |
| `cards:read` (legacy) | The three Cards reads, Results/Saved/Sent selections |

All admitted methods in PR 1 are GET with matching HEAD admission. Every bearer is refused on Cards Done, session-only routes, peer/fleet routes, transports, source proxies and all writes. The two legacy values are stored admission values, never selectable scopes.

## Blocked

(none)

## Found, not fixed

(behaviour defects exposed by this work, with route, evidence and why the fix is out of scope here)

## Decisions made during implementation

- 2026-10-28: Handoff prerequisite complete. Closeout #245 (`b51ec2ce`) was verified on fetched main with all 19 rows merged and final verification recorded. Cleanup #247 merged as `870b1b5144a265dd778122320d13cd99aba66a14`, #248 as `938e04e3e53bbf71bfa26598eebcce28daf5f7ab`, and #249 as `568a4ac34a4e586446842b76a44602bea82e0807`; each passed `npm run check` and one complete review pass. Full evidence and review limits are in those PRs.
- PR 1 starts from `568a4ac34a4e586446842b76a44602bea82e0807`. Owner decisions in PROMPT.md control: three selectable scopes; retain both legacy grants; token writes stay closed until PR 2.
- Cleanup #247 review raised design questions for implementation, without a confirmed runtime finding: bootstrap connection metadata versus denied connection management; token/session owner separation and linked-source refusal; PR 3 connection-generation acknowledgements; PR 4 concurrent outbox uniqueness, retention and unusual IP classes. Resolve each in its owning implementation PR.

- PR 1: Bootstrap keeps its existing safe connection descriptors (labels/models/status), while connection management and all credential fields remain outside token access. It skips workspace-project creation for bearer reads. HTTP clock bookkeeping explicitly tests the bearer marker.
- PR 1: The mounted matcher uses Express probe routers with the registrar's matching options; Cards preserves literal mount casing as well as strict route casing/trailing slashes. A second contract guard protects actual handler dispatch. Host-local management and fleet/peer dispatch cannot precede bearer refusal.
- PR 1: Legacy creation and metadata wire shapes remain supported. Existing HTTP Cards assertions remain intact; internal tests now call the mounted matcher, seed JSON-array storage, and pass admission arrays to `cardDetail`. The generated security assertion changes intentionally to include IntegrationBearer.
- PR 1: Standard token-management errors reuse existing OpenAPI response components; Cards read error descriptions and payloads remain unchanged. No fleet document changes.
- PR 1: The scope migration rebuilds `card_tokens` from a temporary backup within the migration runner's transaction, avoiding a global SQLite table rename. Disclosure rows are restored after recreating their foreign-key target.
- 2026-10-28 owner instruction: run full test suites only when about to open or merge a PR. Use focused checks while editing; keep full verification at those gates.
- PR 1 rebased onto `11117ba81c18d6a891d986d48643a3bd8b1cc703` before opening after #246 merged. Preserve the new `peer:credentials` access kind and lifecycle; its registry also uses string-only `FleetRouteContract`, and every token admission is refused on challenge and issue through both production profiles. Contract-document conflicts retain the merged machine-proof requirements.
- PR 1 then rebased without conflicts onto `9f344641ec06f2a709e010f14cbc262ece3e486e` after #250 merged. Its Antigravity/Pi authentication changes and generated schemas are retained. Final pre-PR Vitest on this VM uses `--maxWorkers=1 --testTimeout=30000 --hookTimeout=30000 --bail=1 --reporter=verbose`; timeout diagnosis and prior results are recorded in the PR evidence, with test assertions unchanged.

- PR 1 review fixes: token Results/updates acquire an immediate transaction before reads and disclosure writes; session snapshots stay deferred. Bearer responses omit JSON owner clocks and Feed display-delta metadata. HEAD never records disclosures, including legacy Cards; its authorization and selection stay unchanged. The concurrent-writer HTTP fixture failed with 500 before the fix on server and companion, then passed after the fix. Focused verification passed 44 cases across five files.

- 2026-10-28: Two interruptions ended pre-merge native runs without completion summaries. Full-suite verification now uses all eight Vitest and four native shards with durable per-shard exits. Shard 3 then exposed the two existing expiry HTTP fixtures’ ten-second outer budgets; only those outer budgets become 30 seconds, preserving every deadline assertion. The full 15-case file passed. Production code is unchanged from `a85b7f31`; completed unaffected shards and build/smoke/startup results remain applicable. Failed/interrupted attempts and exact commands are recorded in the PR.

- PR 1 pass-2 design questions: reserved `write` and `approvals:decide` are accepted only when explicitly requested through the session-owned creation API, as the spec’s `TokenScope[]` creation schema requires; they admit no route here and are not offered in Settings until PR 2 supplies identity. Their later admission follows the requested scope, never an implicit/default grant. Feed’s `filter=done` belongs to the separately admitted Feed read; Cards Done remains session-only, preserving the explicit Cards selection rule and both legacy grants. These are intentional boundaries from the PR 1 spec, not outstanding findings.

## Review history

- 2026-10-28: PR #252 pass 1 requested for head `631ec9bb777db1eaf7c58f90ed2676b78f96dd29`, captured base `9f344641ec06f2a709e010f14cbc262ece3e486e`, preflight fingerprint `966198263a668d0881cb29f110dc6de26d77dcfe1b61e847f49aa083d4801761`. All checks passed: convention gate 241 cases/24 files, full Vitest 2,262 cases/258 files, native 323 cases, build, Card smoke and fresh/upgrade startup. Review ID `248fe88b-34fe-4fcf-97db-8b38926c169c`, lead conversation `ef4691bf-3670-4226-a935-677088cf3493`; all three reviewers completed. P0/P1: 0; confirmed security findings: none. Three P2s to fix: deferred Results snapshot upgrades during disclosure writes, bearer JSON clock metadata and HEAD collection disclosure recording. Fleet Authorization concern was rejected using the existing peer protocol admission; no code change is needed for it.

- 2026-10-28: PR #252 pass 2 requested for head `ef4e7ecf2b7430565e686e55c68b185c05b24214`, captured base `9f344641ec06f2a709e010f14cbc262ece3e486e`, preflight fingerprint `43717ac54a24c19d85e7e335cb6c466724cbcedca52c92e507afa0ee416ff29a`. All pass-1 P2 findings are fixed. Convention gate: 243 cases/24 files; all eight Vitest shards: 2,264 cases/258 files; all four native shards: 323 cases; build, Card smoke and fresh/upgrade startup passed. Production sources are unchanged from `a85b7f31`; completed unaffected checks and shards from that head remain valid after the two outer fixture-budget changes in `ef4e7ecf`. Exact commands, commit provenance and failed/interrupted attempts are in the PR. Capture includes all 46 changed files, 279,653 diff bytes, 13,576,225 context bytes and 1,511 tree entries; largest blob 511,932 bytes. Review ID `eeca563d-4227-49f3-a29b-90883fa1d220`, lead conversation `50fada7d-637d-4d6c-b3c2-871e83ee5722`; all three reviewers completed. No confirmed P0/P1/P2 or security findings. The lead independently rejected the Fleet Authorization concern using the existing peer admission and transport. Review is static, with no tests run; fixture verification above remains separate from live deployment/provider/device behavior.
