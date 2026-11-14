import { useSourceId } from "./SourceContext";
import {
  CollectionReadNotice,
  usePagedProjectionQuery,
} from "./CollectionRead";
import { readRoute } from "./api";
import { workspaceApi } from "../shared/workspace-api";
import { Reply } from "lucide-react";
import type { Agent } from "../shared/types";
import type { RouteResponse } from "../shared/workspace-api";
import { Empty, RichText } from "./components";
import type { ComposerContext } from "./composerContext";

type Page = RouteResponse<typeof workspaceApi.agentMessages>;
type MessagePage = Page & { refreshAfterPaging: boolean };

export function AgentMessages({
  agent,
  revision,
  onConversation,
  onReply,
}: {
  agent: Agent;
  revision: number;
  onConversation: (id: string) => void;
  onReply: (context: ComposerContext) => void;
}) {
  const source = useSourceId();
  const agentId = agent.id;
  const reader = usePagedProjectionQuery<MessagePage, string>({
    key: agentId,
    source,
    revision,
    pauseOnPageHide: true,
    empty: { items: [], next: null, refreshAfterPaging: false },
    collections: [],
    events: [],
    queueMore: true,
    requireAdvance: true,
    refreshDelay: () => 0,
    needsRefresh: (page) => page.refreshAfterPaging,
    read: async (old, before, signal) => {
      const page = await readRoute(
        workspaceApi.agentMessages,
        { params: { id: agentId }, query: { before } },
        source,
        signal,
        undefined,
        "once",
      );
      const ids = new Set(old.items.map((item) => item.id));
      const gap =
        page.next !== null && !page.items.some((item) => ids.has(item.id));
      return {
        items: [
          ...new Map(
            [...old.items, ...page.items].map((item) => [item.id, item]),
          ).values(),
        ].sort(
          (a, b) =>
            b.created_at - a.created_at ||
            Number(b.final) - Number(a.final) ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        ),
        next:
          before === undefined && page.next !== null && old.items.length && !gap
            ? old.next
            : page.next,
        refreshAfterPaging: before !== undefined,
      };
    },
  });
  const { items, next } = reader.page;
  const error = reader.error;
  const loading = reader.loading && !items.length;
  const moreBusy = reader.appending;
  const earlier = reader.more;
  return (
    <section className="feed" aria-label="Agent messages">
      <p className="field-hint">
        Intermediate updates and final answers from this agent. Final answers
        are also in Results.
      </p>
      <CollectionReadNotice
        error={error}
        busy={reader.loading}
        retry={reader.retry}
      />
      {loading && <p role="status">Loading conversation history…</p>}
      {!loading && !items.length && !error && (
        <Empty title="No agent messages yet.">{null}</Empty>
      )}
      {items.map((item) => (
        <article className="feed-card" key={item.id}>
          <span className="eyebrow">
            {item.final ? "Final response" : "Agent message"}
          </span>
          <time className="field-hint">
            {new Date(item.created_at).toLocaleString()}
          </time>
          <RichText content={item.content} />
          {item.conversation_id && (
            <div className="agent-message-actions">
              <button
                className="secondary"
                onClick={() =>
                  onReply({
                    agentId: agent.id,
                    conversationId: item.conversation_id!,
                    messageId: item.id,
                    content: item.content,
                  })
                }
              >
                <Reply size={16} aria-hidden="true" /> Reply
              </button>
              <button
                className="text-button"
                onClick={() => onConversation(item.conversation_id!)}
              >
                Open conversation
              </button>
            </div>
          )}
        </article>
      ))}
      {next && (
        <button
          className="secondary"
          disabled={moreBusy}
          onClick={() => void earlier()}
        >
          {moreBusy ? "Loading…" : "Earlier messages"}
        </button>
      )}
    </section>
  );
}
