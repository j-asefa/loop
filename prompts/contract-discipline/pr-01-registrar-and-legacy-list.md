# PR 1: the registrar and the named legacy list

No dependencies. Branch from `origin/main` at or after `9cd36102`. Server and client mechanisms land together because the acceptance criterion is "no door left open", but neither changes behaviour.

## Goal

After this PR, a route can only be registered through a contract or through a named legacy entry, and the browser can only reach `/api` through a typed contract or a named legacy path. Adding a new untyped route or raw client path requires editing a list file that every reviewer sees by name. The type checker enforces this, not a test.

## Server

1. Create `src/server/registrar.ts`:
   - `registrar(name: string)` returns `{ on, legacy, mount }`. `mount` is the only thing `index.ts` receives: type it as `RequestHandler`, not `Router`, so nothing downstream can call `.get` on it. The Express `Router` instance is a closure variable.
   - `on(contract, handler)` registers `contract.method`/`contract.path` wrapped with the existing `route()` from `src/server/route.ts`. Move `route()` into the registrar module or import it; either way `route()` stops being exported to route files.
   - `legacy(key, handler)` registers an untyped handler. `key` is typed as `keyof typeof LEGACY_ROUTES`; the method and path come from the list entry, never from the call. A key can be registered once; a second registration throws at startup.
   - Router options stay as they are today (`card-routes.ts` uses `strict: true, caseSensitive: true`; keep per-registrar options as a parameter).
2. Create `src/shared/legacy-routes.ts` exporting `LEGACY_ROUTES` as a `const` object keyed `"METHOD /path"` with the value naming the owning router, for example `"POST /connections": "core"`. Seed it with every currently untyped registration in these files: `core-routes.ts`, `mobile-routes.ts`, `workspace-routes.ts`, `news.ts`, `companion-routes.ts`, `teams.ts`, `memory.ts`, `github-pulls.ts`, `feed-watches.ts`, `agent-definitions.ts`, `pr-watches.ts`, `feed-digests.ts`, `agent-mail.ts`, `sharing.ts`, `runtime-hosts.ts`, `notifications.ts`, `native-history.ts`, `subscriptions.ts`, `viewport-diagnostics.ts`, `activities.ts`, and the `app.get`/`app.post`/`app.all` registrations in `index.ts` (`/api/capabilities`, `/api/health`, `/api/build`, `/api/diagnostic`, `/api/events`, the `/api/mcp/*` family). At `9cd36102` this is about 205 entries; record the exact number in the ledger. `news.ts` contains one `Map.get` call whose argument looks like a path (`${feed}:${story.id}`); it is not a route.
3. Convert every registration in those files to `on(...)` for the eight already-typed routes or `legacy(...)` for the rest. Handlers do not change. Each file exports its `mount` under the name `index.ts` already imports (`core`, `mobile`, …) so the `app.use("/api", …)` lines in `index.ts` do not change.
4. `card-routes.ts` keeps its `cardApi[...]` registrations until PR 2 folds the Cards registry in; register them through `legacy` for now with keys for the three card reads and three token routes.
5. The direct `app.*` registrations in `index.ts` move behind a registrar named `app` mounted first, so the ordering of the `/api` middleware chain (card admission, design preview boundary, companion) is unchanged. Verify the order by reading `index.ts` lines 120 to 365 at the current head; the middleware that depends on `req.headers.authorization` must still run before any router.

## Client

1. In `src/client/api.ts`, change the `path` parameter of `api()`, `apiInWorkspace()`, `readInWorkspace()` and `authorizedFetch()` from `string` to `LegacyClientPath`, a union type exported from a new `src/client/legacy-paths.ts`. Entries are template-literal types so existing call sites compile unchanged, for example `` `/agents/${string}/traces` `` and `/me/profile`. Seed the list by compiling: add the minimal pattern for each call site the type checker rejects. Do not edit call sites in `src/client/App.tsx` while reactive PR 12b is open; add patterns for them instead and note them in the ledger. A call site that passes a variable of type `string` must be narrowed at the call site or, if it is in `App.tsx`, recorded as deferred.
2. `callRoute` and `readRoute` keep taking contracts; they are the only way to reach a typed route. The existing nine `callRoute` and five `readRoute` call sites do not change.
3. Nothing about transport, cancellation, retry or authorization changes.

## Tests

- `test/registrar.test.ts`: `on` wraps with `route()` behaviour (reuse the helper-app pattern at the top of `test/workspace-route-contracts.test.ts`); duplicate legacy key throws; a legacy key not in the list fails to compile (`@ts-expect-error`); `mount` has no `get`/`post` at the type level (`@ts-expect-error`).
- `test/legacy-routes.test.ts`: every key in `LEGACY_ROUTES` is registered exactly once on the production `app`, and every mounted `/api` route is either a registry contract or a legacy key. Walk the Express router stack of the production `app` imported from `src/server/index.ts`. This is a consistency check that keeps the list honest in both directions; it is not a count and it has no threshold.
- Full baseline. `npm run cards:check` stays green (nothing in the Cards registry changed).
- `npm run smoke:design` and `npm run smoke:history` because every route file changed; the diff is mechanical but the smokes prove nothing reordered.

## Capture limits

Twenty-one route files plus `index.ts`, `api.ts`, two list files and two tests. Check the capture size before requesting review. If it does not fit, split as 1a (registrar, list, `index.ts`, `core-routes.ts`, `mobile-routes.ts`, `workspace-routes.ts`, client) and 1b (the remaining route files); 1a must already remove the raw `Router` export from the files it converts, and 1b finishes the rest. Do not leave any file exporting a `Router` after 1b.

## Acceptance

No file under `src/server` exports an Express `Router`. `grep -rE "\.(get|post|put|patch|delete|all)\(" src/server --include=*.ts` matches only the registrar module. `route()` is not imported outside the registrar. `api()` and its siblings reject a `string` path at compile time. The two list files exist and the ledger records their starting sizes. All handlers unchanged; all smokes pass.
