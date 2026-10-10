import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { api } from "./api";
import { Avatar, RichText } from "./components";
import { AttachmentList } from "./Attachments";
import type { Agent, Provider } from "../shared/types";
import type { UploadedFile } from "../shared/uploads";

type Prompt = {
  id: string;
  content: string;
  created_at: number;
  conversation_id: string;
  conversation_title: string;
  agent_name: string | null;
  agent_id: string | null;
  provider: Provider | null;
  project_name: string | null;
  attachments: UploadedFile[];
};
type Page = { items: Prompt[]; next: string | null };
/** Plain clicks on a sent-message card open its conversation, but controls,
 * links and text selection inside the card keep their own behavior. */
export function opensConversationFromCard(
  target: EventTarget | null,
  card: Pick<Element, "contains">,
  selection = "",
) {
  if (selection) return false;
  const control = (target as Partial<Element> | null)?.closest?.(
    "a, button, input, textarea, select, summary, label, video, audio, [role=button]",
  );
  return !control || !card.contains(control);
}
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
  const [page, setPage] = useState<Page>({ items: [], next: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [request, setRequest] = useState<{ before?: string }>({});
  const [filter, setFilter] = useState(query.trim());
  useEffect(() => {
    if (query.trim() === filter) return;
    const timer = setTimeout(() => {
      setFilter(query.trim());
      setRequest({});
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  // Pull to refresh reloads the newest prompts.
  useEffect(() => {
    const refresh = () => setRequest({});
    window.addEventListener("loop-refresh", refresh);
    return () => window.removeEventListener("loop-refresh", refresh);
  }, []);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (request.before) params.set("before", request.before);
    if (filter) params.set("q", filter);
    api<Page>(
      "/me/prompts" + (params.size ? "?" + params : ""),
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setPage((old) => ({
            items: request.before
              ? [
                  ...new Map(
                    [...old.items, ...result.items].map((item) => [
                      item.id,
                      item,
                    ]),
                  ).values(),
                ]
              : result.items,
            next: result.next,
          }));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request, filter]);
  useEffect(() => {
    if (loading || error || !page.next || !sentinel.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setRequest({ before: page.next! });
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loading, error, page.next]);
  return (
    <section className="feed personal-history" aria-label="Your sent prompts">
      {!embedded && (
      <header className="profile-head personal-profile-head">
        <span className="avatar user" role="img" aria-label={name + " avatar"}>
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
      {page.items.map((item) => {
        const agent = agents.find((candidate) => candidate.id === item.agent_id);
        return (
        <article
          className="feed-card personal-message-card"
          key={item.id}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              !opensConversationFromCard(
                event.target,
                event.currentTarget,
                window.getSelection()?.toString(),
              )
            )
              return;
            onConversation(item.conversation_id, item.id);
          }}
        >
          <div className="personal-recipient">
            {agent ? (
              <button className="personal-agent-avatar" aria-label={`Open ${agent.name} profile`} onClick={() => onAgent(agent)}>
                <Avatar name={agent.name} provider={agent.provider} />
              </button>
            ) : <Avatar name={item.agent_name || "Recipient unavailable"} provider={item.provider || undefined} />}
            <div>
              <small className="muted">You sent a message to</small>
              {agent ? (
                <button className="text-button personal-agent-name" onClick={() => onAgent(agent)}>{agent.name}</button>
              ) : <strong>{item.agent_name || "Recipient unavailable"}</strong>}
            </div>
          </div>
          <RichText content={item.content} />
          <AttachmentList files={item.attachments} />
          <p className="personal-message-context">{item.project_name || "No project"} · {item.conversation_title}</p>
          <footer className="personal-message-footer">
          <time dateTime={new Date(item.created_at).toISOString()}>
            {new Date(item.created_at).toLocaleString()}
          </time>
          {onReply && item.agent_id && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                onReply({
                  id: item.id,
                  content: item.content,
                  conversation_id: item.conversation_id,
                  agent_id: item.agent_id!,
                })
              }
            >
              <MessageSquare size={15} /> Reply
            </button>
          )}
          <a
            href={`/?conversation=${encodeURIComponent(item.conversation_id)}&message=${encodeURIComponent(item.id)}`}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onConversation(item.conversation_id, item.id);
            }}
          >
            Open conversation
          </a>
          </footer>
        </article>
        );
      })}
      {loading && <p role="status">Loading prompts…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setRequest({ ...request })}>Retry</button>
        </div>
      )}
      {!loading && !error && !page.items.length && (
        <p>{filter ? "No prompts match your search." : "You haven’t sent any prompts yet."}</p>
      )}
      {!loading && !error && page.items.length > 0 && !page.next && (
        <p>End of your prompt history.</p>
      )}
      <div ref={sentinel}>
        {!loading && !error && page.next && (
          <button onClick={() => setRequest({ before: page.next! })}>
            Load more prompts
          </button>
        )}
      </div>
    </section>
  );
}
