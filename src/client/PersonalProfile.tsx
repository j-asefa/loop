import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { RichText } from "./components";
import { AttachmentList } from "./Attachments";
import type { UploadedFile } from "../shared/uploads";

type Prompt = {
  id: string;
  content: string;
  created_at: number;
  conversation_id: string;
  conversation_title: string;
  agent_name: string | null;
  project_name: string | null;
  attachments: UploadedFile[];
};
type Page = { items: Prompt[]; next: string | null };
export function PersonalProfile({
  name,
  onConversation,
}: {
  name: string;
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
      <p>{name} · Your prompts across all your projects.</p>
      {page.items.map((item) => (
        <article className="feed-card" key={item.id}>
          <div className="personal-recipient">
            <span className="personal-avatar" aria-hidden="true">
              {(item.agent_name || "?").slice(0, 1)}
            </span>
            <strong>{item.agent_name || "Recipient unavailable"}</strong>
          </div>
          <p className="field-hint">
            {item.project_name || "No project"} · {item.conversation_title}
          </p>
          <time dateTime={new Date(item.created_at).toISOString()}>
            {new Date(item.created_at).toLocaleString()}
          </time>
          {item.content.length > 1200 ? (
            <details>
              <summary>{item.content.slice(0, 180)}… — Expand prompt</summary>
              <RichText content={item.content} />
            </details>
          ) : (
            <RichText content={item.content} />
          )}
          <AttachmentList files={item.attachments} />
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
        </article>
      ))}
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
