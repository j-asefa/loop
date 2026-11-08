import { workspaceApi, type RouteInput } from "./workspace-api.js";
import type {
  DoneThreadDetail,
  DoneThreadQuery,
  DoneThreadSummary,
} from "./done-threads.js";

type ThreadReadContract =
  | typeof workspaceApi.doneThreadListPage
  | typeof workspaceApi.doneThreadDetailPage;
export type ThreadReadTransport = <C extends ThreadReadContract>(
  contract: C,
  input: RouteInput<C>,
  signal?: AbortSignal,
) => Promise<unknown>;

function advance(seen: Set<string>, next: string | null) {
  if (next && seen.has(next))
    throw new Error("Thread pagination did not advance.");
  if (next) seen.add(next);
  return next ?? undefined;
}

function readFailure(error: unknown): never {
  if ((error as { status?: number } | null)?.status === 413)
    throw new Error(
      "This result is too large to open here. Open its original conversation.",
    );
  throw error;
}

/** One transport retains its owning source and cancellation lifetime on every
 * page. A partial read never falls back to an unrelated unpaged snapshot. */
export function contractDoneThreadReader(request: ThreadReadTransport) {
  return {
    async list(query: DoneThreadQuery = {}, signal?: AbortSignal) {
      const threads: DoneThreadSummary[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        signal?.throwIfAborted();
        let page;
        try {
          page = workspaceApi.doneThreadListPage.response.parse(
            await request(
              workspaceApi.doneThreadListPage,
              { query: { ...query, cursor } },
              signal,
            ),
          );
        } catch (error) {
          readFailure(error);
        }
        threads.push(...page.threads);
        cursor = advance(seen, page.next);
      } while (cursor);
      return threads;
    },
    async detail(id: string, signal?: AbortSignal): Promise<DoneThreadDetail> {
      let result: DoneThreadDetail | undefined;
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        signal?.throwIfAborted();
        let page;
        try {
          page = workspaceApi.doneThreadDetailPage.response.parse(
            await request(
              workspaceApi.doneThreadDetailPage,
              { params: { id }, query: { cursor } },
              signal,
            ),
          );
        } catch (error) {
          readFailure(error);
        }
        if (
          page.thread.id !== id ||
          (result &&
            JSON.stringify(result.thread.cardIds) !==
              JSON.stringify(page.thread.cardIds))
        )
          throw new Error(
            "Thread membership changed. Refresh to read it again.",
          );
        result ??= { thread: page.thread, cards: [] };
        result.cards.push(...page.cards);
        if (result.cards.length > 100)
          throw new Error("Thread response exceeded its member limit.");
        cursor = advance(seen, page.next);
      } while (cursor);
      if (
        JSON.stringify(result!.cards.map((card) => card.id)) !==
        JSON.stringify(result!.thread.cardIds)
      )
        throw new Error("Thread response omitted or repeated a member.");
      return result!;
    },
  };
}
