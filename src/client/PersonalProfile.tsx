import { useEffect, useRef, useState } from "react";
import { ContentCard } from "./ContentCard";
import { useCards } from "./useCards";
import type { Agent, Provider } from "../shared/types";

export { opensContentCard as opensConversationFromCard } from "./ContentCard";
export type PromptReply = {
  id: string;
  content: string;
  conversation_id: string;
  agent_id: string;
};
export function PersonalProfile({
  name,
  onConversation,
  onReply,
  agents,
  onAgent,
  embedded = false,
  query = "",
}: {
  name: string;
  embedded?: boolean;
  query?: string;
  agents: Agent[];
  onAgent: (agent: Agent) => void;
  onConversation: (id: string, message: string) => void;
  /** Quote this prompt in its thread, like replying to any other message. */
  onReply?: (prompt: PromptReply) => void;
}) {
  const [filter, setFilter] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setFilter(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const { items, next, loading, error, load } = useCards({
    view: "sent",
    ...(filter ? { q: filter } : {}),
  });
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (loading || error || !next || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loading, error, next, load]);
  return (
    <section className="feed personal-history" aria-label="Your sent prompts">
      {!embedded && (
        <header className="profile-head personal-profile-head">
          <span
            className="avatar user"
            role="img"
            aria-label={name + " avatar"}
          >
            {name
              .trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => Array.from(part)[0])
              .join("")
              .toUpperCase()}
          </span>
          <h1>{name}</h1>
          <span className="personal-you">You</span>
          <p className="muted">Your personal workspace</p>
          <p>Your messages and work with agents, across all your projects.</p>
        </header>
      )}
      {!embedded && <h2 className="personal-section-title">Sent messages</h2>}
      {items.map(({ card }) => {
        if (card.type !== "message") return null;
        const agent = agents.find(
          (candidate) => candidate.id === card.recipient?.id,
        );
        return (
          <ContentCard
            key={card.id}
            card={card}
            onOpen={() =>
              onConversation(
                card.source.conversation_id!,
                card.source.message_id!,
              )
            }
            onProfile={agent ? () => onAgent(agent) : undefined}
            onReply={
              onReply && card.recipient?.id
                ? () =>
                    onReply({
                      id: card.source.message_id!,
                      content: card.content,
                      conversation_id: card.source.conversation_id!,
                      agent_id: card.recipient!.id!,
                    })
                : undefined
            }
          />
        );
      })}
      {loading && <p role="status">Loading prompts…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}
      {!loading && !error && !items.length && (
        <p>
          {filter
            ? "No prompts match your search."
            : "You haven’t sent any prompts yet."}
        </p>
      )}
      {!loading && !error && items.length > 0 && !next && (
        <p>End of your prompt history.</p>
      )}
      <div ref={sentinel}>
        {!loading && !error && next && (
          <button onClick={() => void load(true)}>Load more prompts</button>
        )}
      </div>
    </section>
  );
}
