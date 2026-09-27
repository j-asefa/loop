import { useEffect, useState } from "react";
import { Reply } from "lucide-react";
import type { Agent } from "../shared/types";
import { api } from "./api";
import { Avatar, Badge, Empty, RichText, Sheet } from "./components";
import { ResultReply } from "./ResultReply";

type AgentMessage = {
  id: string;
  content: string;
  created_at: number;
  conversation_id: string | null;
  final: number | boolean;
};
type Page = { items: AgentMessage[]; next: string | null };

export function AgentMessages({
  agent,
  revision,
  onConversation,
  onSent,
}: {
  agent: Agent;
  revision: number;
  onConversation: (id: string) => void;
  onSent: () => void;
}) {
  const agentId = agent.id;
  const [reply, setReply] = useState<AgentMessage | null>(null);
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
    void api<Page>(`/agents/${agentId}/messages`)
      .then((page) => {
        if (active) {
          merge(page, true);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentId, revision, moreBusy]);
  const earlier = async () => {
    if (!next || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await api<Page>(
        `/agents/${agentId}/messages?before=${encodeURIComponent(next)}`,
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
              <button className="secondary" onClick={() => setReply(item)}>
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
      {reply && (
        <Sheet
          key={reply.id}
          wide
          swipeToClose
          className="result-sheet message-reply-sheet"
          title={`Reply to @${agent.name}`}
          onClose={() => setReply(null)}
          heading={
            <div className="result-header">
              <Avatar name={agent.name} provider={agent.provider} />
              <div className="result-author">
                <h2>@{agent.name}</h2>
                <Badge provider={agent.provider} />
                <time dateTime={new Date(reply.created_at).toISOString()}>
                  {new Date(reply.created_at).toLocaleString()}
                </time>
              </div>
            </div>
          }
        >
          <div className="result-content">
            <p className="eyebrow">Replying to this message</p>
            <blockquote className="message-reply-quote">
              <RichText content={reply.content} />
            </blockquote>
          </div>
          <ResultReply
            item={reply}
            agent={agent}
            replyToMessageId={reply.id}
            onSent={() => {
              setReply((current) =>
                current?.id === reply.id ? null : current,
              );
              onSent();
            }}
          />
        </Sheet>
      )}
    </section>
  );
}
