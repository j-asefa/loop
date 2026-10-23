# PR 12: split the two god modules

Depends on PR 11. Pure moves; split into 12a (server) and 12b (client). A move counts twice in the review capture, so check the capture size before each request.

## Goal

`src/server/native-sessions.ts` is about two thousand lines mixing Pi package trust and inspection, project registration, workspace preparation, a three-hundred-line `event()` switch, run execution and recovery. `src/client/App.tsx` is over four thousand lines and owns refresh orchestration for every view, most of which PR 7 made unnecessary. Split both along the seams the earlier PRs exposed, with no behaviour change. The acceptance criterion applies to these two modules and what is extracted from them; `Feed.tsx`, `Conversation.tsx`, `Social.tsx` and `mobile-return.ts` are also large and are explicitly not in scope unless PR 9b left the `mobile-return.ts` moves for here.

## Server (12a)

- `native/supervisor.ts`: process lifetime, generations, `session()`, `dispose()`, `recover()`, `close()`, idle handling, and the single-worker lease from PR 8.
- `native/projector.ts`: `event()` and `projectOutput()`, taking a live session and an `AdapterEvent` and producing database writes and bus events; the PR 7 reducer tests already exercise it.
- `native/decisions.ts`: requests, answers, auto-approval, expiry.
- `native/pi-customization.ts`: `piConfiguration`, `piTrustDecision`, `piInspectPackage`, `piPackages`.
- `native/projects.ts`: `addProject`, `directory`, registrations and catalogs.
- `native-sessions.ts` remains as the thin facade the worker boundary from PR 8 imports, so call sites do not change.

## Client (12b)

- Delete the refresh orchestration PR 7 left dead.
- Extract from `App.tsx`: the session and auth shell, workspace data loading and caching, the results pager, and the composer, each with explicit props. `App.tsx` becomes composition. No visual change; the design smokes are the guard.

## Constraints

- Every moved function keeps its name and signature in this PR; renames are a later change.
- Tests move with their code; no test is deleted; compare the test file list before and after in the PR body.
- Each half stays within the capture limits; if 12b cannot, split by extracted module.

## Tests

The full baseline plus `smoke:design`, `smoke:history`, `smoke:companion` and `smoke:feed-events`.

## Acceptance

`native-sessions.ts` and `App.tsx` are each under about five hundred lines of facade and composition; every extracted module is under about fifteen hundred lines; all smokes pass; the ledger's final report lists every PR as merged.
