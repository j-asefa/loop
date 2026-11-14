import { useProjectionRoute } from "./SourceContext";
import { workspaceApi } from "../shared/workspace-api";
import { useEffect, useState } from "react";
import { Reply } from "lucide-react";
import type { Agent } from "../shared/types";
import type { RouteResponse } from "../shared/workspace-api";
import { Empty, RichText } from "./components";
import type { ComposerContext } from "./composerContext";

type Page = RouteResponse<typeof workspaceApi.agentMessages>;

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
  const readProjection = useProjectionRoute();

  const agentId = agent.id;
  const [{ items, next }, setPage] = useState<Page>({ items: [], next: null });
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const merge = (page: Page, refresh = false) =>
    setPage((old) => {
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
          refresh && page.next !== null && old.items.length && !gap
            ? old.next
            : page.next,
      };
    });
  useEffect(() => {
    if (moreBusy) return;
    let active = true;
    const request = new AbortController();
    const cancel = () => request.abort();
    // Stop reads before WebKit tears down a document during navigation.
    window.addEventListener("pagehide", cancel);
    void readProjection(
      workspaceApi.agentMessages,
      { params: { id: agentId } },
      { mode: "manual", signal: request.signal },
    )
      .then((page) => {
        if (active) {
          merge(page, true);
          setError("");
        }
      })
      .catch((e) => {
        if (active && !request.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      cancel();
      window.removeEventListener("pagehide", cancel);
    };
  }, [agentId, revision, moreBusy]);
  const earlier = async () => {
    if (!next || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await readProjection(
        workspaceApi.agentMessages,
        {
          params: { id: agentId },
          query: { before: next },
        },
        { mode: "manual" },
      );
      merge(page);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMoreBusy(false);
    }
  };
  return (
    <section className="feed" aria-label="Agent messages">
      <p className="field-hint">
        Intermediate updates and final answers from this agent. Final answers
        are also in Results.
      </p>
      {error && <p role="alert">{error}</p>}
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
