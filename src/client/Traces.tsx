import { useEffect, useState } from "react";
import { ArrowUpRight, ListTree } from "lucide-react";
import { api, parse } from "./api";
import { Empty, RichText } from "./components";
import type { Artifact } from "../shared/types";

type Trace = {
  id: number;
  run_id: string;
  kind: string;
  title: string;
  content: string;
  metadata: string;
  artifact_id: string | null;
  created_at: number;
  input: string;
  run_state: string;
  conversation_id: string | null;
};
type Page = { items: Trace[]; next: number | null };
export function Traces({
  agentId,
  revision,
  onConversation,
  onArtifact,
}: {
  agentId: string;
  revision: number;
  onConversation: (id: string) => void;
  onArtifact: (item: Artifact) => void;
}) {
  const [{ items, next }, setPage] = useState<Page>({ items: [], next: null });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const merge = (page: Page, refresh = false) =>
    setPage((old) => {
      // A disjoint newest page creates an unloaded gap, even if the previous
      // visit had reached the end. Start pagination above that gap again.
      const oldIds = new Set(old.items.map((item) => item.id));
      const gap =
        page.next !== null && !page.items.some((item) => oldIds.has(item.id));
      return {
        items: [
          ...new Map(
            [...old.items, ...page.items].map((item) => [item.id, item]),
          ).values(),
        ].sort((a, b) => b.id - a.id),
        next: refresh
          ? gap
            ? Math.max(old.next || 0, page.next!)
            : old.next
          : page.next,
      };
    });
  useEffect(() => {
    // Finish paging before refreshing so an older response cannot overwrite
    // the cursor for a newly discovered gap.
    if (moreBusy) return;
    let current = true;
    void api<Page>(`/agents/${agentId}/traces`)
      .then((page) => {
        if (!current) return;
        merge(page, true);
        setError("");
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [agentId, revision, moreBusy]);
  const earlier = async () => {
    if (!next || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await api<Page>(`/agents/${agentId}/traces?before=${next}`);
      merge(page);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMoreBusy(false);
    }
  };
  return (
    <section className="trace-list" aria-label="Agent traces">
      <p className="field-hint">
        Updates and tool activity from this agent. Final answers appear in
        Outputs.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading traces…</p>}
      {!loading && !items.length && (
        <Empty title="No traces yet.">
          Activity will appear here when this agent starts working.
        </Empty>
      )}
      {items.map((item) => {
        const meta = parse<any>(item.metadata, {});
        const state =
          meta.state === "running" || meta.state === "waiting"
            ? ["completed", "failed", "cancelled", "interrupted"].includes(
                item.run_state,
              )
              ? item.run_state
              : meta.state
            : meta.state;
        return (
          <article className="trace-card" key={item.id}>
            <div className="trace-heading">
              <ListTree size={18} />
              <strong>{item.title.replaceAll("_", " ")}</strong>
              {state && <span className="status">{state}</span>}
            </div>
            <div className="trace-context">
              <span>{item.input}</span>
              <time>{new Date(item.created_at).toLocaleString()}</time>
            </div>
            {item.content && (
              <details open={item.kind === "message" || meta.isError === true}>
                <summary>
                  {meta.isError
                    ? "Tool error"
                    : meta.final
                      ? "Answer"
                      : "Details"}
                </summary>
                <RichText content={item.content} />
              </details>
            )}
            <div className="actions">
              {item.artifact_id && (
                <button
                  onClick={async () => {
                    try {
                      onArtifact(
                        await api<Artifact>(`/artifacts/${item.artifact_id}`),
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  View tool result <ArrowUpRight size={15} />
                </button>
              )}
              {item.conversation_id && (
                <button onClick={() => onConversation(item.conversation_id!)}>
                  Open conversation
                </button>
              )}
            </div>
          </article>
        );
      })}
      {next && (
        <button
          className="secondary load-more"
          disabled={moreBusy}
          onClick={() => void earlier()}
        >
          {moreBusy ? "Loading…" : "Earlier traces"}
        </button>
      )}
    </section>
  );
}
