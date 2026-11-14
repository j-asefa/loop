import { ArtifactId, RunId, parseId } from "../shared/contract-ids.js";
import { AgentId } from "../shared/contract-ids.js";
import { literalEntry } from "./textEntry";
import { workspaceApi } from "../shared/workspace-api";
import {
  useSourceId,
  useSourceOperation,
  useSourceRoute,
} from "./SourceContext";
import type { RouteResponse } from "../shared/workspace-api";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Download,
  ListTree,
  MessageSquare,
  Search,
} from "lucide-react";
import { parse } from "./json";
import { viewGeneration } from "./viewCache";
import { watchWorkspaceDetail } from "./workspace-multiplex";
import { Empty, RichText } from "./components";
import type { Artifact } from "../shared/types";

type Page = RouteResponse<typeof workspaceApi.agentTraces>;
type Trace = Page["items"][number];
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
  const source = useSourceId();
  const generation = viewGeneration();
  useEffect(
    () =>
      props.runId
        ? watchWorkspaceDetail(source, { run: props.runId })
        : undefined,
    [source, props.runId, generation],
  );
  return (
    <TraceSearch
      key={JSON.stringify([
        source,
        viewGeneration(),
        props.agentId,
        props.runId,
      ])}
      {...props}
    />
  );
}
function TraceSearch(props: Props) {
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
          {...literalEntry}
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
  agentId: rawAgentId,
  runId,
  revision,
  onConversation,
  onArtifact,
  query,
}: Props & { query: string }) {
  const agentId = AgentId.parse(rawAgentId);
  const route = useSourceRoute();
  const downloadReason = useSourceOperation(workspaceApi.agentTracesExport);
  const artifactReason = useSourceOperation(workspaceApi.artifactDetail);
  const generation = useRef(viewGeneration()).current;
  const active = useRef(true);
  const pending = useRef(new Set<AbortController>());
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const request of pending.current) request.abort();
      pending.current.clear();
    };
  }, []);
  const current = () => active.current && generation === viewGeneration();
  const request = () => {
    const controller = new AbortController();
    pending.current.add(controller);
    return {
      signal: controller.signal,
      current: () => current() && !controller.signal.aborted,
      done: () => pending.current.delete(controller),
    };
  };
  const [{ items, next }, setPage] = useState<Page>({ items: [], next: null });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const downloading = useRef(false);
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
    let live = true;
    const request = new AbortController();
    void route(
      workspaceApi.agentTraces,
      {
        params: { id: agentId },
        query: {
          run: parseId(RunId, runId || undefined),
          q: query || undefined,
        },
      },
      request.signal,
    )
      .then((page) => {
        if (!live || !current()) return;
        merge(page, true);
        setError("");
      })
      .catch((e) => {
        if (live && current()) setError(e.message);
      })
      .finally(() => {
        if (live && current()) setLoading(false);
      });
    return () => {
      live = false;
      request.abort();
    };
  }, [agentId, runId, query, revision, moreBusy, route]);
  const earlier = async () => {
    if (!next || moreBusy || !current()) return;
    const operation = request();
    setMoreBusy(true);
    try {
      const page = await route(
        workspaceApi.agentTraces,
        {
          params: { id: agentId },
          query: {
            before: String(next),
            run: parseId(RunId, runId || undefined),
            q: query || undefined,
          },
        },
        operation.signal,
      );
      if (!operation.current()) return;
      merge(page);
      setError("");
    } catch (e) {
      if (operation.current()) setError((e as Error).message);
    } finally {
      operation.done();
      if (operation.current()) setMoreBusy(false);
    }
  };
  const download = (trace: Trace) => {
    if (current())
      saveJson(`loop-trace-${trace.run_id}-${trace.id}.json`, trace);
  };
  const downloadRun = async (id: string) => {
    if (!current() || downloadReason || downloading.current) return;
    downloading.current = true;
    setDownloadBusy(true);
    const operation = request();
    try {
      const file = await route(
        workspaceApi.agentTracesExport,
        { params: { id: agentId }, query: { run: parseId(RunId, id) } },
        operation.signal,
      );
      if (!operation.current()) return;
      const text = await file.text();
      if (operation.current())
        saveJson(`loop-run-${id}-traces.json`, JSON.parse(text));
    } catch (e) {
      if (operation.current()) setError((e as Error).message);
    } finally {
      operation.done();
      downloading.current = false;
      if (operation.current()) setDownloadBusy(false);
    }
  };
  const openArtifact = async (id: string) => {
    if (!current() || artifactReason) return;
    const operation = request();
    try {
      const artifact = await route(
        workspaceApi.artifactDetail,
        { params: { id: ArtifactId.parse(id) } },
        operation.signal,
      );
      if (operation.current()) onArtifact(artifact);
    } catch (e) {
      if (operation.current()) setError((e as Error).message);
    } finally {
      operation.done();
    }
  };
  return (
    <>
      {[...new Set([downloadReason, artifactReason])]
        .filter(Boolean)
        .map((reason) => (
          <p className="field-hint" key={reason} role="status">
            {reason}
          </p>
        ))}
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
                    onClick={() =>
                      current() && onConversation(group[0].conversation_id!)
                    }
                  >
                    Open conversation <ArrowUpRight size={15} />
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={!!downloadReason || downloadBusy}
                  aria-busy={downloadBusy}
                  title={downloadReason}
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
              const meta = parse<{
                state?: string;
                isError?: boolean;
                final?: boolean;
                failure?: { phase?: string; code?: unknown };
              }>(item.metadata, {});
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
                        disabled={!!artifactReason}
                        title={artifactReason}
                        onClick={() => void openArtifact(item.artifact_id!)}
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
