# PR 5: thread open from cache

Depends on PR 3. Independent of the delta work, so it lands early.

## Goal

Opening a thread renders nothing until the network answers, sometimes needs two sequential round trips, and under load can fail outright. Make an open render immediately from cache, need one request, and degrade politely under rate limiting.

## Current behavior to verify

- `src/client/Conversation.tsx` sets the data to null on open and shows a spinner; there is no cached transcript, unlike the Feed's `cachedView`.
- The initial load fetches the latest page and, only when the saved reading position is not on it, fetches the page around that position (around line 410). Two round trips in that case.
- `src/server/index.ts` applies a 600 per minute per-owner limit on the server profile; the client handles 429 only in Card tokens, so a thread load during a busy period fails with "Too many requests".
- `src/linked-docker.ts` forwards a fixed allowlist of response headers (around line 221) that omits `Retry-After`, so paired Docker requests would lose it.
- The route at `src/server/core-routes.ts` `GET /conversations/:id` is already cheap; do not optimise the query.

## Changes

1. **Cache.** Store the last rendered transcript page per owner, source and conversation using the Feed's `cachedView` mechanism, render it on open, then reconcile with the fetch. Late responses for a different owner or conversation are discarded by the existing generation checks.
2. **One request.** The server cannot tell an initial load from an ordinary refresh: `Conversation.tsx` around line 404 sends the same unadorned GET for both. Add an explicit `resume=1` query parameter that the client sends only on the initial load with no anchor. With it, the route returns the page around the saved reading position when that position is outside the latest page, and flags that it did. Without it, and with explicit `message` or `before`, behaviour is unchanged, so a refresh after a resume returns the latest page. Delete the client's second fetch.
3. **429 handling.** `src/client/api.ts` surfaces `Retry-After`; `watchWorkspaceEvents` and remaining fallback polls back off for that duration; the thread shows cached content with a quiet status line instead of an error. Add `retry-after` to the linked Docker response-header allowlist.
4. **Request inventory.** List in the PR body exactly which requests an open fires before and after. Do not remove polls here; PR 7 does that with coverage proof.

## Tests

- `test/conversation-paging.test.ts`: resume page served in one request with `resume=1`; the unadorned GET after a resume returns the latest page, not the saved older page; anchor and cursor behaviour unchanged.
- Client: open with cache renders before the fetch resolves; a 429 keeps the cached page and schedules the retry after the header's duration; the linked proxy forwards the header.
- `smoke:history` passes.

## Acceptance

First paint of a previously opened thread occurs before any network response; a cold open needs one conversation request; a 429 never blanks the thread, directly or through a linked source.
