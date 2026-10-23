import { listenWorkspaceChanges } from "./workspace-changes";
import { useEffect, useRef, useState } from "react";
import { useSourceApi, useSourceId } from "./SourceContext";
import { PublishedFile } from "./PublishedFiles";
import type { PersonalFilesPage } from "../shared/personal-files";

const empty: PersonalFilesPage = {
  items: [],
  next: null,
  agents: [],
  projects: [],
};
export function PersonalFiles({
  onConversation,
}: {
  onConversation: (id: string) => void;
}) {
  const api = useSourceApi();
  const source = useSourceId();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({
    q: "",
    agent: "",
    project: "",
    type: "all",
  });
  const actions = useRef({ more: () => {}, retry: () => {} });
  const [page, setPage] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = search.trim();
      setQuery((old) => (old.q === q ? old : { ...old, q }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value) queryParams.set(key, value);
    let current = empty;
    let busy = false;
    let pending = false;
    let urgent = false;
    let refreshAfter = 0;
    let retryBefore: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      pending = true;
      if (busy || timer || controller.signal.aborted) return;
      // Files can span many pages. Coalesce streaming notifications so a
      // library refresh does not repeat all those reads for every token.
      timer = setTimeout(
        () => void load(),
        urgent ? 0 : Math.max(0, refreshAfter - Date.now()),
      );
    };
    const load = async (before?: number) => {
      if (busy || controller.signal.aborted) return;
      clearTimeout(timer);
      timer = undefined;
      busy = true;
      retryBefore = before;
      if (!before) {
        pending = false;
        urgent = false;
      }
      setLoading(true);
      setError("");
      const boundary = before ? undefined : current.items.at(-1)?.cursor;
      let cursor = before;
      let result: PersonalFilesPage | undefined;
      const items: PersonalFilesPage["items"] = [];
      let reads = 0;
      try {
        do {
          const params = new URLSearchParams(queryParams);
          if (cursor) params.set("before", String(cursor));
          result = await api<PersonalFilesPage>(
            "/me/files?" + params,
            undefined,
            undefined,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          reads++;
          if (cursor && result.next && result.next >= cursor)
            throw new Error("Files pagination did not advance. Please retry.");
          items.push(...result.items);
          cursor = result.next ?? undefined;
          // Reconcile through the oldest visible cursor, including new files
          // spanning multiple pages. Commit together to retain rows and scroll
          // during refresh, with a contiguous Load more boundary afterwards.
        } while (!before && boundary && cursor && cursor > boundary);
        current = {
          ...result,
          items: [
            ...new Map(
              [...(before ? current.items : []), ...items].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ],
        };
        setPage(current);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        if (!before) refreshAfter = Date.now() + Math.max(5000, reads * 1800);
        if (!controller.signal.aborted) {
          setLoading(false);
          if (pending) schedule();
        }
      }
    };
    const refresh = (event: Event) => {
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      if (sources && !sources.includes(source)) return;
      if (event.type === "loop-refresh") {
        urgent = true;
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    };
    actions.current = {
      more: () => {
        if (current.next) void load(current.next);
      },
      retry: () => void load(retryBefore),
    };
    setPage(empty);
    void load();
    window.addEventListener("loop-refresh", refresh);
    const stopChanges = listenWorkspaceChanges("results", refresh, source);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("loop-refresh", refresh);
      stopChanges();
    };
  }, [api, query, source]);
  function filter(key: "agent" | "project" | "type", value: string) {
    setQuery((old) => ({ ...old, [key]: value }));
  }
  return (
    <section className="personal-files" aria-label="Your files">
      <p className="muted">
        Files published by your agents, across your projects.
      </p>
      <label>
        Search files
        <input
          type="search"
          value={search}
          maxLength={200}
          placeholder="Filename or title"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="personal-files-filters">
        <label>
          Type
          <select
            aria-label="Type"
            value={query.type}
            onChange={(event) => filter("type", event.target.value)}
          >
            <option value="all">All types</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="html">HTML</option>
            <option value="other">Other files</option>
          </select>
        </label>
        <label>
          Agent
          <select
            aria-label="Agent"
            value={query.agent}
            onChange={(event) => filter("agent", event.target.value)}
          >
            <option value="">All agents</option>
            {page.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select
            aria-label="Project"
            value={query.project}
            onChange={(event) => filter("project", event.target.value)}
          >
            <option value="">All projects</option>
            {page.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="personal-files-list">
        {page.items.map((item) => (
          <article className="feed-card" key={item.id}>
            <PublishedFile item={item} preview={false} />
            <p className="muted">
              {item.agent_name || "Agent unavailable"} ·{" "}
              {item.project_name || "No project"} ·{" "}
              <time dateTime={new Date(item.created_at).toISOString()}>
                {new Date(item.created_at).toLocaleDateString()}
              </time>
            </p>
            {item.conversation_id && (
              <button
                className="text-button"
                onClick={() => onConversation(item.conversation_id!)}
              >
                Open conversation
              </button>
            )}
          </article>
        ))}
      </div>
      {loading && <p role="status">Loading files…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => actions.current.retry()}>Retry</button>
        </div>
      )}
      {!loading && !error && !page.items.length && (
        <p>
          {Object.values(query).some((value) => value && value !== "all")
            ? "No files match your filters."
            : "No published files yet. Ask an agent to publish a file to Loop and it will appear here."}
        </p>
      )}
      {!loading && !error && page.next && (
        <button onClick={() => actions.current.more()}>Load more files</button>
      )}
    </section>
  );
}
