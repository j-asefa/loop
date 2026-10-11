import { useEffect, useState } from "react";
import { useSourceApi } from "./SourceContext";
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
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({
    q: "",
    agent: "",
    project: "",
    type: "all",
  });
  const [request, setRequest] = useState<{ before?: number }>({});
  const [page, setPage] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((old) => ({ ...old, q: search.trim() }));
      setRequest({});
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const refresh = () => setRequest({});
    window.addEventListener("loop-refresh", refresh);
    window.addEventListener("loop-workspace-change", refresh);
    return () => {
      window.removeEventListener("loop-refresh", refresh);
      window.removeEventListener("loop-workspace-change", refresh);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    if (!request.before) setPage((old) => ({ ...old, items: [], next: null }));
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value) params.set(key, value);
    if (request.before) params.set("before", String(request.before));
    api<PersonalFilesPage>(
      "/me/files?" + params,
      undefined,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setPage((old) => ({
            ...result,
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
          }));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, query, request]);
  function filter(key: "agent" | "project" | "type", value: string) {
    setQuery((old) => ({ ...old, [key]: value }));
    setRequest({});
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
          <button onClick={() => setRequest({ ...request })}>Retry</button>
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
        <button onClick={() => setRequest({ before: page.next! })}>
          Load more files
        </button>
      )}
    </section>
  );
}
