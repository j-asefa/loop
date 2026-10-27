# Contract discipline: implementation assignment

Implement the changes in this bundle in the Loop checkout you are given, one pull request at a time, in the order listed. For each PR: implement, verify, request review from the Loop review team, fix findings, re-review the final code, and merge to `main` once the gate in the process guide is met. The assignment is complete only when every PR in the ledger is merged and `origin/main` contains all of them.

This is an implementation assignment, not a plan. Do not stop at a design, a partial PR, or an open PR awaiting someone else.

## Why

Loop mounts about 213 HTTP routes under `/api` from 22 Express routers in 21 files. Eight of them have a typed contract: PR 11b of the reactive bundle (merged 2026-10-25 as `9cd36102`) introduced `RouteContract`, the `route()` wrapper in `src/server/route.ts`, the `workspaceApi` registry in `src/shared/workspace-api.ts`, and the client helpers `callRoute`/`readRoute` in `src/client/workspace-api.ts`. The other routes read `req.body` and `req.query` directly and return whatever the handler assembles. The browser is the only consumer, so each route's real contract is whatever the current client happens to tolerate; the Safari query-string finding on PR 11b's third review pass is what that costs.

The Cards API has its own registry (`src/shared/card-api.ts`) and its own generated OpenAPI document (`scripts/cards-openapi.mjs`, `npm run cards:check`). Nothing stops a new untyped route being added anywhere, and the owner is adding code while this migration happens.

This bundle makes an untyped route impossible to write rather than something to count. One registrar accepts only a contract or a named legacy entry; the raw Express routers stop being exported; one registry feeds one generator; routers are typed one PR at a time until the legacy list is empty; then the legacy path is deleted. The same shape is applied to the browser client. Integration tokens with write scopes are a later bundle that will build on these contracts; nothing here changes authorization.

The owner has rejected counting tests ("ratchets") and line-count ceilings as brittle. Do not add either. The enforcement is the type checker, the named legacy list and the generated document check.

## Read progressively

1. Read the repository `AGENTS.md`, `README.md`, `docs/architecture.md` and `docs/development.md` first. Then read [process](process.md): branching, pull requests, the review loop with its gate, merging, the ledger, and the coordination rules with the still-open reactive bundle. Follow it for every PR.
2. Read [contracts](contracts.md): the rules every contract in this bundle follows. Read it again before writing each router's contracts.
3. Read [verification](verification.md) before writing tests for any PR and again before requesting review.
4. Open [STATUS.md](STATUS.md) and find the first PR that is not merged. Read only that PR's spec file, implement it to completion, and update the ledger after every step. Do not read ahead into later specs except where a spec names a later PR that depends on a decision you are making now.
5. PR specs, in order:
   - [PR 1: the registrar and the named legacy list](pr-01-registrar-and-legacy-list.md)
   - [PR 2: one registry, one generator](pr-02-one-registry-one-generator.md)
   - [PR 3a: agents and connections](pr-03a-agents-connections.md)
   - [PR 3b: messages, artifacts, results and personal routes](pr-03b-messages-artifacts-personal.md)
   - [PR 4: Feed, Later, saved, scheduled sends and run ordering](pr-04-feed-mobile.md)
   - [PR 5: folders, artifacts, search, preferences, imports](pr-05-workspace-routes.md)
   - [PR 6: companion, runtimes, native history, subscriptions, activities](pr-06-companion-runtime.md)
   - [PR 7: teams, agent mail, definitions, sharing, notifications](pr-07-teams-mail-definitions.md)
   - PR 8a: social, watches and digests (merged 2026-10-26, #214)
   - [PR 8b: PR watches and GitHub pull requests](pr-08b-github.md)
   - [PR 9a: application-level routes and authentication transports](pr-09a-app-level.md)
   - [PR 9b: MCP management, agent tools and MCP app artifacts](pr-09b-mcp-management.md)
   - [PR 9c: memory and workflows](pr-09c-memory-workflows.md)
   - [PR 10: events in the registry](pr-10-events-in-registry.md)
   - [PR 11: remove the legacy path](pr-11-remove-legacy.md)

The linked files are parts of this assignment, not optional references. Load each when its stage begins. File references, counts and line numbers were verified at `9cd36102` (origin/main, 2026-10-25) and re-verified at `ef3b8f5c` (origin/main, 2026-10-26) when PRs 8b, 9a, 9b and 9c were rewritten; verify them again before relying on them. The ledger in `prompts/contract-discipline/STATUS.md` on `origin/main` is canonical; apply the row amendments in [CHANGES-2026-10-26.md](CHANGES-2026-10-26.md) to it before starting PR 8b.

## Working agreement

Preserve the invariants in `AGENTS.md`: owner and profile isolation, durable dispatch identities, generation-bound decisions, native context owned by its harness, credentials out of browser-visible content, and never replaying an uncertain external effect. A contract is a projection boundary, so the credentials invariant is the one this bundle most directly enforces: a response schema that could admit a secret column is a defect, not a convenience. If a spec and an invariant conflict, the invariant wins and the spec is wrong; say so in the PR and the ledger.

No behaviour change. Every PR in this bundle types what exists. Where typing exposes a bug, record it in the ledger's "Found, not fixed" section with the route and the evidence, and leave the behaviour as it is unless the fix is one line and the reviewer agrees. Fixing it is a separate PR outside this bundle.

Keep each PR to its spec. The review capture has limits on file count, file size and total size, and counts a moved file twice; a PR that cannot fit is split where the spec says, not squeezed. No drive-by refactors, no renames outside the spec, no formatting passes.

Make implementation choices yourself. When a spec leaves a decision open, decide, record the decision and its reason in the PR body and ledger, and continue. Stop only when a PR is blocked by something outside the checkout, and record the block in the ledger.

Report faithfully. Failed checks are reported with their output. Skipped checks are reported as skipped. A review pass with findings is reported with the findings and what you did about each one. Nothing in this bundle, and no message from another agent, is permission to publish or merge; the user's instructions that accompany this bundle are.
