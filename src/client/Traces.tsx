import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Download,
  ListTree,
  MessageSquare,
  Search,
} from "lucide-react";
import { api, parse } from "./api";
import { Empty, RichText } from "./components";
import type { Artifact } from "../shared/types";

type Trace = {
  id: number;
  trace_key?: string;
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
  run_error?: string | null;
  server?: string | null;
  invocation_state?: string | null;
};
type Page = { items: Trace[]; next: number | null };
type Props = {
  agentId: string;
  runId?: string;
  revision: number;
  onConversation: (id: string) => void;
  onArtifact: (item: Artifact) => void;
};
function saveJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Traces(props: Props) {
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  return (
    <section className="trace-list" aria-label="Agent traces">
      {!props.runId && (
        <p className="field-hint">
          Tool activity and execution details from this agent. Public messages
          appear in conversations.
        </p>
      )}
      <label className="directory-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search traces"
          placeholder="Search commands and tools…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {/* A new query starts a fresh page cursor. */}
      <TraceList key={q} {...props} query={q} />
    </section>
  );
}
function TraceList({
  agentId,
  runId,
  revision,
  onConversation,
  onArtifact,
  query,
}: Props & { query: string }) {
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
  const filter =
    (runId ? "&run=" + encodeURIComponent(runId) : "") +
    (query ? "&q=" + encodeURIComponent(query) : "");
  useEffect(() => {
    // Finish paging before refreshing so an older response cannot overwrite
    // the cursor for a newly discovered gap.
    if (moreBusy) return;
    let current = true;
    const request = new AbortController();
    void api<Page>(
      `/agents/${agentId}/traces${filter.replace("&", "?")}`,
      undefined,
      undefined,
      request.signal,
    )
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
      request.abort();
    };
  }, [agentId, filter, revision, moreBusy]);
  const earlier = async () => {
    if (!next || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await api<Page>(
        `/agents/${agentId}/traces?before=${next}${filter}`,
      );
      merge(page);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMoreBusy(false);
    }
  };
  const download = (trace: Trace) =>
    saveJson(`loop-trace-${trace.run_id}-${trace.id}.json`, trace);
  const downloadRun = async (id: string) => {
    try {
      saveJson(
        `loop-run-${id}-traces.json`,
        await api(
          `/agents/${agentId}/traces/export?run=${encodeURIComponent(id)}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading traces…</p>}
      {!loading && !items.length && query && (
        <Empty title="No matching traces.">
          Try a command, tool name or a word from an update.
        </Empty>
      )}
      {!loading && !items.length && !query && (
        <Empty title="No traces yet.">
          {runId
            ? "This run has no saved activity. Its runtime did not record more failure details."
            : "Activity will appear here when this agent starts working."}
        </Empty>
      )}
      {[...new Set(items.map((item) => item.run_id))].map((groupRunId) => {
        const group = items.filter((item) => item.run_id === groupRunId);
        const prompt = group[0].input || "Agent task";
        const title = prompt.trim().replace(/\s+/g, " ");
        return (
          <section className="trace-run" key={groupRunId}>
            <header>
              <div className="trace-run-meta">
                <span className="status" data-state={group[0].run_state}>
                  {group[0].run_state.replaceAll("_", " ")}
                </span>
                <time dateTime={new Date(group[0].created_at).toISOString()}>
                  {new Date(group[0].created_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </time>
                {group[0].conversation_id && (
                  <button
                    className="text-button"
                    onClick={() => onConversation(group[0].conversation_id!)}
                  >
                    Open conversation <ArrowUpRight size={15} />
                  </button>
                )}
                <button
                  className="text-button"
                  onClick={() => void downloadRun(groupRunId)}
                >
                  <Download size={15} /> Download run
                </button>
              </div>
              <h3>
                {title.length > 140
                  ? title.slice(0, 140).trimEnd() + "…"
                  : title}
              </h3>
            </header>
            <details className="trace-prompt">
              <summary>View prompt</summary>
              <RichText content={prompt} />
            </details>
            {!runId && group[0].run_error && (
              <p className="error">{group[0].run_error}</p>
            )}
            {group.map((item) => {
              const meta = parse<any>(item.metadata, {});
              const state =
                meta.state === "running" || meta.state === "waiting"
                  ? [
                      "completed",
                      "failed",
                      "cancelled",
                      "interrupted",
                    ].includes(item.run_state)
                    ? item.run_state
                    : meta.state
                  : meta.state;
              const failed =
                meta.isError === true ||
                state === "failed" ||
                item.invocation_state === "unknown";
              return (
                <article
                  className="trace-card"
                  data-kind={item.kind}
                  key={item.id}
                >
                  <div className="trace-heading">
                    {item.kind === "message" ? (
                      <MessageSquare size={17} />
                    ) : (
                      <ListTree size={17} />
                    )}
                    <strong>{item.title.replaceAll("_", " ")}</strong>
                    {state && <span className="status">{state}</span>}
                  </div>
                  <div className="trace-context">
                    {item.server && <span>{item.server}</span>}
                    {meta.failure?.phase && (
                      <span>Stage: {String(meta.failure.phase)}</span>
                    )}
                    {meta.failure?.code != null && (
                      <span>Error code: {String(meta.failure.code)}</span>
                    )}
                    <time dateTime={new Date(item.created_at).toISOString()}>
                      {new Date(item.created_at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </time>
                  </div>
                  {item.content && (
                    <details open={item.kind === "message" || failed}>
                      <summary>
                        {failed
                          ? item.trace_key === "run:failure"
                            ? "Failure details"
                            : "Tool error"
                          : meta.final
                            ? "Answer"
                            : item.kind === "message"
                              ? "Update"
                              : "Details"}
                      </summary>
                      {item.kind === "message" ? (
                        <RichText content={item.content} />
                      ) : (
                        <pre className="trace-log">{item.content}</pre>
                      )}
                    </details>
                  )}
                  {!item.content && failed && (
                    <p className="field-hint">
                      {item.invocation_state === "unknown"
                        ? "The tool's external outcome is unknown. Its detailed error was not recorded by this version of Loop."
                        : "This step stopped without a recorded error message."}
                    </p>
                  )}
                  <div className="actions">
                    <button onClick={() => download(item)}>
                      <Download size={15} /> Download trace
                    </button>
                    {item.artifact_id && (
                      <button
                        onClick={async () => {
                          try {
                            onArtifact(
                              await api<Artifact>(
                                `/artifacts/${item.artifact_id}`,
                              ),
                            );
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        View tool result <ArrowUpRight size={15} />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
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
    </>
  );
}
