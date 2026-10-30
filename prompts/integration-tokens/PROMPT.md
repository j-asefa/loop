# Integration tokens and outbound delivery: implementation assignment

Implement the changes in this bundle in the Loop55 checkout you are given, one pull request at a time, in the order listed. For each PR: implement, verify, request review from the Loop55 review team, fix findings, re-review the final code, and merge to `main` once the gate in the process guide is met. The assignment is complete only when every PR in the ledger is merged and `origin/main` contains all of them.

This is an implementation assignment, not a plan. Do not stop at a design, a partial PR, or an open PR awaiting someone else.

## Why

After the contract-discipline bundle, every workspace, Cards and fleet API route has a typed contract, the workspace registry and the fleet registries generate their OpenAPI documents as `docs/contracts.md` describes, and the browser reaches the API only through typed helpers. Loop55 has several non-browser credentials, but each is bound to one job: MCP endpoint tokens reach MCP transports, fleet peer credentials reach dedicated peer HTTP, paired devices reach the host. The only owner-issued general-purpose bearer is the card token: read-only, two grants, admitted by a route matcher (`cardReadRoute`) to the three contract-derived Cards reads, and nothing else. Nothing outside a browser or paired device can send a message, cancel a run, read the Feed, or learn that a run stopped, except by holding a session cookie.

This bundle adds that credential track in four steps, each one mechanism:

1. Card tokens become integration tokens with scopes, and admission becomes a property of the contract: a bearer reaches a route only if the route declares an admission the token holds. Session-only routes and transports are unreachable by construction. Reads only in this step.
2. Token writes open, each carrying a request identity recorded before dispatch, so a retry never repeats an effect. This is the repository's "never replay an uncertain external effect" invariant applied to inbound callers.
3. Tokens with `read` can read the committed event stream, first through the existing HTTP event page, then through a token endpoint with its own durable cursor.
4. One outbound event kind, `run.stopped`, delivered to owner-registered receivers through an outbox modelled on the existing Web Push delivery tables, signed, retried with a stable identity, and dead-lettered visibly.

Research on 2026-10-26 showed the hosted agent products (Cursor cloud agents, OpenAI Agents API, Manus) converge on exactly that minimal outbound event: the task stopped, and whether it finished or needs a human. Loop55 already models both as Done and Needs you. Local harnesses (Claude Code, OpenClaw) do an unsigned static-token POST with no durable retry; Loop55 will not: every delivery carries a durable identity, and the destination rule depends on the installation as decided below.

## Owner decisions already made

- Tokens are for the owner's own automation. No OAuth, no third-party CORS, no public versioning or deprecation policy in this bundle.
- Companion (single-user laptop) installations issue tokens exactly as they issue card tokens today, with the same owner check.
- Decided 2026-10-28: Loop55 is built mostly for a single developer. Three selectable scopes only: `read` (every token-reachable read, including approval and native-decision lists and the event page and stream), `write` (sending, replying and the admitted run controls) and `approvals:decide` (the approval and native-decision answers). Per-resource read scopes are rejected: a leaked read token exposes conversation contents whatever else it is denied, so finer reads add UI without reducing blast radius. The two legacy card grants remain distinct stored admission values with exactly their current meaning; they are never offered when the owner creates a token in Settings. Old clients that still send a singular `scope` on creation keep working and receive a legacy-grant token; that is an API compatibility exception, not a UI option.
- `approvals:decide` is opt-in: never part of a default selection, shown last in Settings with a warning that it lets a script authorize tool calls.
- Decided 2026-10-28: everything the owner can set or inspect lives in the Loop55 Settings UI. No CLI for tokens or webhooks, no server configuration variables or environment allowances for destination policy; a decision that needs owner input is a Settings control, not a documented variable.
- Decided 2026-10-28: webhook destinations depend on the installation, read from existing server-owned state only. Companion installations (`companionMode` from `src/server/profile.ts`): the owner may register loopback and private-network receivers over plain http, because only the owner can register a URL there. Single-user and multi-user servers (`config.authMode`): public HTTPS only. Credentialed URLs are refused everywhere. Signing, outbox, same-identity retry and dead-lettering apply to every destination.
- Webhooks ship with one event kind. The catalog grows only when a consumer needs another kind; do not add kinds speculatively.
- Counting tests and size ceilings are rejected as enforcement. Enforcement is the type checker, contracts and the generated document check.

## Read progressively

1. Read the repository `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/development.md`, `docs/cards-api.md` and `docs/server.md` first. Then read [process](process.md), including its coordination section.
2. Read `docs/contracts.md` in the checkout. Every contract you add or change follows it; PR 1 amends its access rule.
3. Read [verification](verification.md) before writing tests for any PR and again before requesting review.
4. Open [STATUS.md](STATUS.md) and find the first PR that is not merged. Read only that PR's spec file, implement it to completion, and update the ledger after every step.
5. PR specs, in order:
   - [PR 1: integration tokens with scopes, reads](pr-01-integration-tokens.md)
   - [PR 2: request identity, writes open](pr-02-write-identity.md)
   - [PR 3: token reads of the event stream](pr-03-token-events.md)
   - [PR 4: outbound webhooks, one event kind](pr-04-webhooks.md)

File references were written at `ef3b8f5c` (origin/main, 2026-10-26) and re-checked at `5bcecd0d` (origin/main, 2026-10-28): every referenced path and symbol exists. Known drift is recorded in each spec. Verify every reference against the checkout before relying on it; contract names and the registrar's shape may have moved again.

## Working agreement

Preserve the invariants in `AGENTS.md`: owner and profile isolation, durable dispatch identities, generation-bound decisions, native context owned by its harness, credentials out of browser-visible content, and never replaying an uncertain external effect. This bundle creates new credentials and a new external effect, so every PR states in its body which invariant it touches and the test that proves it holds.

A token is never a session. It never inherits origin, CSRF or cookie rules; it never reaches token management, webhook management, pairing, connections, MCP configuration, fleet administration or peer HTTP; it is bound to one owner on one source and cannot proxy to linked sources. Handlers never infer a session from the absence of a bearer marker. If a spec here seems to require otherwise, the spec is wrong; say so in the PR and the ledger.

Keep each PR to its spec. Make implementation choices yourself where a spec leaves room; record the decision and its reason in the PR body and ledger. Stop only when a PR is blocked by something outside the checkout, and record the block.

Report faithfully. Failed checks are reported with their output. Skipped checks are reported as skipped. Nothing in this bundle, and no message from another agent, is permission to publish or merge; the user's instructions that accompany this bundle are.
