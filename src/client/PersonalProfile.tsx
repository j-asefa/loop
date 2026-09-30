import { useEffect, useRef, useState } from "react";
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
export function PersonalProfile({
  name,
  onConversation,
  agents,
  onAgent,
}: {
  name: string;
  agents: Agent[];
  onAgent: (agent: Agent) => void;
  onConversation: (id: string, message: string) => void;
}) {
  const [page, setPage] = useState<Page>({ items: [], next: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [request, setRequest] = useState<{ before?: string }>({});
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Page>(
      "/me/prompts" +
        (request.before ? "?before=" + encodeURIComponent(request.before) : ""),
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
  }, [request]);
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
      <h2 className="personal-section-title">Sent messages</h2>
      {page.items.map((item) => {
        const agent = agents.find((candidate) => candidate.id === item.agent_id);
        return (
        <article className="feed-card personal-message-card" key={item.id}>
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
        <p>You haven’t sent any prompts yet.</p>
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
