import { literalEntry } from "./textEntry";
import { workspaceApi, type RouteInput } from "../shared/workspace-api";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useEffect, useRef, useState } from "react";
import { useSourceRoute, useSourceId } from "./SourceContext";
import { PublishedFile } from "./PublishedFiles";
import type { PersonalFilesPage } from "../shared/personal-files";

type FileType = NonNullable<
  NonNullable<RouteInput<typeof workspaceApi.personalFiles>["query"]>["type"]
>;

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
  const call = useSourceRoute();
  const source = useSourceId();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<{
    q: string;
    agent: string;
    project: string;
    type: FileType;
  }>({
    q: "",
    agent: "",
    project: "",
    type: "all",
  });
  const actions = useRef({ more: () => {}, retry: () => {} });
  const [page, setPage] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [appending, setAppending] = useState(false);
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
    let current = empty;
    let busy = false;
    let appendPending = false;
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
      setAppending(!!before || appendPending);
      setError("");
      const boundary = before ? undefined : current.items.at(-1)?.cursor;
      let cursor = before;
      let result: PersonalFilesPage | undefined;
      const items: PersonalFilesPage["items"] = [];
      let reads = 0;
      let complete = false;
      try {
        do {
          result = await call(
            workspaceApi.personalFiles,
            {
              query: {
                ...query,
                q: query.q || undefined,
                agent: query.agent || undefined,
                project: query.project || undefined,
                before: cursor ? String(cursor) : undefined,
              },
            },
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
        complete = true;
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        if (!before) refreshAfter = Date.now() + Math.max(5000, reads * 1800);
        if (!controller.signal.aborted) {
          setLoading(false);
          setAppending(false);
          // A click during refresh uses the newly reconciled cursor. Preserve
          // it across a failed read until Retry succeeds; source/query changes
          // abort this lifetime and discard its pending action.
          const append = complete && appendPending ? current.next : null;
          if (complete) appendPending = false;
          if (append) void load(append);
          else if (pending) schedule();
        }
      }
    };
    const refresh = (event: Event) => {
      const sources = (event as CustomEvent<{ sources?: string[] }>).detail
        ?.sources;
      if (sources && !sources.includes(source)) return;
      if (event.type === "loop55-refresh") {
        urgent = true;
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    };
    actions.current = {
      more: () => {
        if (!current.next || controller.signal.aborted) return;
        if (busy) {
          appendPending = true;
          setAppending(true);
        } else void load(current.next);
      },
      retry: () => void load(retryBefore),
    };
    setPage(empty);
    void load();
    window.addEventListener("loop55-refresh", refresh);
    const stopChanges = listenWorkspaceChanges("results", refresh, source);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("loop55-refresh", refresh);
      stopChanges();
    };
  }, [call, query, source]);
  function filter(key: "agent" | "project" | "type", value: string) {
    if (key === "type") {
      const parsed =
        workspaceApi.personalFiles.query.shape.type.safeParse(value);
      if (parsed.success) setQuery((old) => ({ ...old, type: parsed.data }));
    } else setQuery((old) => ({ ...old, [key]: value }));
  }
  return (
    <section className="personal-files" aria-label="Your files">
      <p className="muted">
        Files published by your agents, across your projects.
      </p>
      <label>
        Search files
        <input
          {...literalEntry}
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
            : "No published files yet. Ask an agent to publish a file to Loop55 and it will appear here."}
        </p>
      )}
      {!error && page.next && (
        <button disabled={appending} onClick={() => actions.current.more()}>
          Load more files
        </button>
      )}
      {/* Refresh progress must not move the control during a pointer press. */}
      {loading && <p role="status">Loading files…</p>}
    </section>
  );
}
