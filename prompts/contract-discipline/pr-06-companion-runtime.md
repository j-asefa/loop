# PR 6: companion, runtimes, native history, subscriptions, activities

Depends on PR 5. Routers: `companion` (15 untyped), `nativeHistory` (3), `subscriptions` (2), `runtimeHosts` (3), `activityRoutes` (1). Twenty-four routes.

## Routes

Companion: `GET /workspace`, `GET /workspace/runtimes`, the `/workspace/runtimes/:name/auth*` group (five), the `/workspace/runtimes/:name/upgrade*` group (four), `POST /workspace/runtimes/:name/enable`, `POST /workspace/projects`, `PATCH /workspace/projects/:id`, `GET /conversations/:id/native`. Native history: `GET /native/history`, `GET /native/history/:id`, `POST /native/history/:id/fork`. Subscriptions: `POST /subscriptions`, `POST /subscriptions/:id/:action`. Runtime hosts: `GET|POST /runtime-hosts`, `DELETE /runtime-hosts/:id`. Activities: `GET /conversations/:id/activities`.

## Rules specific to this PR

- Runtime auth routes return login state for native harnesses. Responses must never include the secret OAuth `device_code` polling token, access/refresh tokens, API keys or credential file contents; these secrets must also stay out of SSE events and logs. Preserve `attempt.code` (the user-facing OAuth `user_code`), `attempt.url` and `attempt.instructions` exactly as the sign-in UI expects: the user verification code alone grants no access. Declare the state fields the browser renders and nothing else. Add a test that a response assembled from a runtime status containing token-like fields keeps `attempt.code` while dropping `device_code` and tokens. This distinction was clarified by the user on 2026-10-26.
- Runtime upgrade routes carry a generation or request identity for the recover path; required in the schema exactly as the handler requires it.
- Native history responses are read-only projections of legacy sessions (`docs/architecture.md`, "Legacy native history"). Type them as display data.
- Activities pages come from `server/activities.ts` with the shared shapes in `agent-activities.ts`. Reuse those schemas; do not duplicate.
- `companion` is mounted only in companion mode and `runtimeHosts` only when capabilities allow; the registrar does not change mounting.

## Client, tests, acceptance

Move call sites; record deferred ones. Full baseline, `openapi:check`, `smoke:companion` in Chromium and WebKit. None of the five routers registers through `legacy`.
