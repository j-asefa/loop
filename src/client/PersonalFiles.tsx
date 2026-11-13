import { usePagedProjectionQuery } from "./CollectionRead";
import { readRoute } from "./api";
import { AgentId, ProjectId, parseId } from "../shared/contract-ids.js";
import { literalEntry } from "./textEntry";
import { workspaceApi, type RouteInput } from "../shared/workspace-api";
import { useEffect, useState } from "react";
import { useSourceId } from "./SourceContext";
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
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = search.trim();
      setQuery((old) => (old.q === q ? old : { ...old, q }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const { page, loading, appending, error, more, retry } =
    usePagedProjectionQuery<PersonalFilesPage, number>({
      key: JSON.stringify(query),
      source,
      empty,
      collections: ["results"],
      queueMore: true,
      refreshDelay: (reads) => Math.max(5000, reads * 1800),
      read: async (current, before, signal, mode, readComplete) => {
        const boundary = before ? undefined : current.items.at(-1)?.cursor;
        let cursor = before;
        let result: PersonalFilesPage | undefined;
        const items: PersonalFilesPage["items"] = [];
        do {
          result = await readRoute(
            workspaceApi.personalFiles,
            {
              query: {
                ...query,
                q: query.q || undefined,
                agent: parseId(AgentId, query.agent || undefined),
                project: parseId(ProjectId, query.project || undefined),
                before: cursor ? String(cursor) : undefined,
              },
            },
            source,
            signal,
            undefined,
            mode,
          );
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          readComplete();
          if (cursor && result.next && result.next >= cursor)
            throw new Error("Files pagination did not advance. Please retry.");
          items.push(...result.items);
          cursor = result.next ?? undefined;
          // Reconcile through the oldest visible cursor, including new files
          // spanning multiple pages. Commit together to retain rows and scroll
          // during refresh, with a contiguous Load more boundary afterwards.
        } while (!before && boundary && cursor && cursor > boundary);
        const page = {
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
        return page;
      },
    });
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
          <button onClick={() => retry()}>Retry</button>
        </div>
      )}
      {!loading && !error && !page.items.length && (
        <p>
          {Object.values(query).some((value) => value && value !== "all")
            ? "No files match your filters."
            : "No published files yet. Ask an agent to publish a file to Loop and it will appear here."}
        </p>
      )}
      {!error && page.next && (
        <button disabled={appending} onClick={() => more()}>
          Load more files
        </button>
      )}
      {/* Refresh progress must not move the control during a pointer press. */}
      {loading && <p role="status">Loading files…</p>}
    </section>
  );
}
