import {
  recentSearches,
  rememberSearch,
  clearRecentSearches,
} from "./deviceHistory";
import { literalEntry, proseEntry } from "./textEntry";
import { matchingAgents } from "./agentSearch";
import { SearchExcerpt } from "./SearchExcerpt";
import { feedCategories, type FeedCategory } from "../shared/feed-categories";
import { executionSourceId } from "./sourceRouting";
import { callRoute, routeUrl } from "./workspace-api";
import {
  workspaceApi,
  type RouteInput,
  type RouteResponse,
} from "../shared/workspace-api";
import { useEffect, useState, useRef, type FormEvent } from "react";
import {
  Folder,
  FileText,
  Plus,
  ChevronRight,
  Bookmark,
  Search,
  X,
  FolderInput,
  ArrowUpRight,
  Undo2,
  Upload,
  Check,
  Cpu,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { parse } from "./json";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { useSourceRoute } from "./SourceContext";
import { Sheet, Empty, Badge } from "./components";
import {
  SettingsList,
  SettingsNote,
  SettingsPill,
  SettingsProgress,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "./SettingsUI";
import { FileLink } from "./FilePreview";
import { PersonalProfile, type PromptReply } from "./PersonalProfile";
import type {
  Artifact,
  Folder as FolderType,
  Agent,
  Connection,
} from "../shared/types";
type SearchResults = RouteResponse<typeof workspaceApi.search>;
type SearchItem = SearchResults["items"][number];

export function FolderForm({
  folders,
  onClose,
  onCreated,
  parent = "",
  existing,
  kind = "folder",
}: {
  folders: FolderType[];
  onClose: () => void;
  onCreated: (folder: FolderType) => void;
  parent?: string;
  existing?: FolderType;
  kind?: "project" | "folder";
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Sheet
      title={`${existing ? "Edit" : "New"} ${existing?.kind || kind}`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            const body = {
              path: String(f.get("path") || "") || undefined,
              name: String(f.get("name") || ""),
              parentId: String(f.get("parent") || "") || null,
            };
            if (existing) {
              await callRoute(
                workspaceApi.folderUpdate,
                { params: { id: existing.id }, body },
                executionSourceId(),
              );
              onCreated({
                ...existing,
                name: String(f.get("name")),
                parent_id: body.parentId,
              });
            } else {
              onCreated(
                await callRoute(
                  workspaceApi.folderCreate,
                  { body: { ...body, kind } },
                  executionSourceId(),
                ),
              );
            }
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Name
          <input
            {...proseEntry}
            name="name"
            defaultValue={existing?.name}
            required
            maxLength={80}
            placeholder="Research Radar"
          />
        </label>
        <label>
          Location
          <select name="parent" defaultValue={existing?.parent_id || parent}>
            <option value="">Workspace</option>
            {folders
              .filter((f) => f.id !== existing?.id && !f.is_workspace)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </label>
        <>
          <label>
            Desktop directory
            <input
              {...literalEntry}
              name="path"
              defaultValue={existing?.path ?? undefined}
              placeholder="/Users/you/projects/my-project"
              maxLength={4096}
            />
          </label>
          <p className="note">
            Native agents inherit the nearest project directory. Existing
            conversations keep their original directory and native settings.
          </p>
        </>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          <Plus size={16} />
          {busy ? "Saving…" : existing ? "Save changes" : `Create ${kind}`}
        </button>
      </form>
    </Sheet>
  );
}
export function FileSheet({
  item,
  folders,
  onClose,
  onChanged,
  initialResult,
}: {
  initialResult?: RouteResponse<typeof workspaceApi.artifactMove>;
  item: Pick<Artifact, "id" | "title" | "folder_id">;
  folders: FolderType[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const call = useSourceRoute();
  const owner = useRef(viewOwner());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && owner.current === viewOwner();
  const [destination, setDestination] = useState(item.folder_id || ""),
    [command, setCommand] = useState(""),
    [result, setResult] = useState<RouteResponse<
      typeof workspaceApi.artifactMove
    > | null>(initialResult || null),
    [error, setError] = useState("");
  async function move(natural = false) {
    if (!current()) return;
    try {
      const r = await call(workspaceApi.artifactMove, {
        params: { id: item.id },
        body: natural ? { command } : { folderId: destination || null },
      });
      if (!current()) return;
      setResult(r);
      onChanged();
    } catch (e) {
      if (current()) setError((e as Error).message);
    }
  }
  return (
    <Sheet title="File this output" onClose={onClose}>
      <p className="muted">{item.title}</p>
      {result ? (
        <div className="note">
          <p>
            <Check size={16} />
            Filed. The original conversation and history are preserved.
          </p>
          <div className="actions">
            <a
              className="text-button"
              href={`/?folder=${result.folderId || "unfiled"}`}
            >
              Open folder
              <ArrowUpRight size={16} />
            </a>
            <button
              onClick={async () => {
                if (!current()) return;
                try {
                  await call(workspaceApi.operationUndo, {
                    params: { id: result.operation },
                    body: {},
                  });
                  if (!current()) return;
                  setResult(null);
                  onChanged();
                } catch (e) {
                  if (current()) setError((e as Error).message);
                }
              }}
            >
              <Undo2 size={16} />
              Undo
            </button>
          </div>
        </div>
      ) : (
        <>
          <label>
            Choose a location
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="">Unfiled</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {folderPath(f.id, folders)}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={() => move()}>
            <FolderInput size={16} />
            Move here
          </button>
          <label>
            Or tell Loop where
            <textarea
              {...proseEntry}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Put this in Research Radar / Reading"
              rows={2}
            />
          </label>
          <button
            className="secondary"
            disabled={!command}
            onClick={() => move(true)}
          >
            File it
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </Sheet>
  );
}
export function folderPath(id: string, folders: FolderType[]) {
  const parts: string[] = [],
    seen = new Set<string>();
  let f = folders.find((f) => f.id === id);
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    parts.unshift(f.name);
    f = folders.find((x) => x.id === f!.parent_id);
  }
  return parts.join(" / ");
}
export function Saved({
  folders,
  folder,
  onFolder,
  onOpen,
  onFile,
  onCreate,
  onEdit,
  version,
  embedded = false,
  initialView = "recent",
}: {
  folders: FolderType[];
  folder: string;
  onFolder: (id: string) => void;
  onOpen: (a: Artifact) => void;
  onFile: (a: Artifact) => void;
  onCreate: () => void;
  onEdit: () => void;
  version: number;
  embedded?: boolean;
  initialView?: "recent" | "folders";
}) {
  const [view, setView] = useState<string>(initialView),
    [items, setItems] = useState<
      RouteResponse<typeof workspaceApi.artifactList>["items"]
    >([]),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const request = useRef(0);
  async function load(append = false) {
    const ticket = ++request.current;
    if (!append && !items.length) setLoading(true);
    setError("");
    try {
      const query: RouteInput<typeof workspaceApi.artifactList>["query"] = {};
      if (!embedded && view === "pinned") query.pinned = "1";
      else if (embedded || view === "folders")
        query.folder = folder || "unfiled";
      if (append && next) query.before = String(next);
      const r = await callRoute(
        workspaceApi.artifactList,
        { query },
        executionSourceId(),
      );
      if (ticket !== request.current) return;
      setItems((prev) => (append ? [...prev, ...r.items] : r.items));
      setNext(r.next);
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [folder, view, version]);
  async function pin(a: Artifact) {
    try {
      await callRoute(
        workspaceApi.artifactUpdate,
        {
          params: { id: a.id },
          body: { pinned: !a.pinned, version: a.version },
        },
        executionSourceId(),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const current = folders.find((f) => f.id === folder);
  return (
    <>
      {current && !current.is_workspace && !embedded && view === "folders" && (
        <button className="text-button" onClick={onEdit}>
          Rename or move this folder
        </button>
      )}
      {!embedded && (
        <div className="feed-filters">
          <div className="segmented">
            {["folders", "recent", "pinned"].map((v) => (
              <button
                key={v}
                className={view === v ? "selected" : ""}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            aria-label="Create folder"
            onClick={onCreate}
          >
            <Plus size={19} />
          </button>
        </div>
      )}
      {(embedded || view === "folders") && (
        <>
          {!embedded && (
            <div className="breadcrumbs">
              <button onClick={() => onFolder("")}>Workspace</button>
              {current && (
                <>
                  <ChevronRight size={14} />
                  <button onClick={() => onFolder(current.parent_id || "")}>
                    {folderPath(current.id, folders)}
                  </button>
                </>
              )}
            </div>
          )}
          <div className="folder-grid">
            {folders
              .filter(
                (f) =>
                  f.parent_id === (folder || null) ||
                  (current?.is_workspace &&
                    f.kind === "folder" &&
                    f.parent_id === null),
              )
              .map((f) => (
                <button key={f.id} onClick={() => onFolder(f.id)}>
                  <Folder size={25} />
                  <span>
                    {f.name}
                    <small>{f.kind}</small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {loading && <p role="status">Loading files…</p>}
      <div className="file-list" aria-busy={loading}>
        {!loading &&
          items.map((a) => (
            <article key={a.id} className="file-row">
              <button onClick={() => onOpen(a)}>
                <FileText size={21} />
                <span>
                  <strong>{a.title}</strong>
                  <small>
                    <Badge provider={a.provider ?? undefined} />
                    {a.kind} · {new Date(a.created_at).toLocaleDateString()}
                  </small>
                </span>
              </button>
              <button
                className="icon-button"
                aria-label={a.pinned ? "Unpin" : "Pin"}
                onClick={() => pin(a)}
              >
                <Bookmark size={17} fill={a.pinned ? "currentColor" : "none"} />
              </button>
              <button
                className="icon-button"
                aria-label={"File " + a.title}
                onClick={() => onFile(a)}
              >
                <FolderInput size={17} />
              </button>
            </article>
          ))}
      </div>
      {!loading && !error && !items.length && (
        <Empty
          title={
            view === "pinned"
              ? "Keep the good stuff close."
              : "Room for what comes next."
          }
        >
          {view === "pinned"
            ? "Pin any output to find it here."
            : "Agent outputs are saved automatically. Move work here from the feed, or start a conversation in this project."}
        </Empty>
      )}
      {next && (
        <button className="secondary" onClick={() => load(true)}>
          Load more
        </button>
      )}
    </>
  );
}
function SearchIndexStatus() {
  const [status, setStatus] = useState<RouteResponse<
    typeof workspaceApi.searchStatus
  > | null>(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      void callRoute(workspaceApi.searchStatus, {}, executionSourceId())
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  if (!status?.enabled) return null;
  return (
    <div className={"search-index-status " + status.state} role="status">
      <strong>
        {status.state === "ready"
          ? "Semantic search ready"
          : status.state === "error" || status.state === "needs_connection"
            ? "Semantic search needs attention"
            : "Preparing semantic search"}
      </strong>
      <span>{status.detail}</span>
      {status.pending > 0 && (
        <>
          <span>
            {status.indexed} of {status.total} items indexed
          </span>
          <SettingsProgress
            label="Indexing progress"
            value={status.indexed}
            total={status.total}
            running
          />
        </>
      )}
    </div>
  );
}
type SearchScope = "all" | "mine" | "results" | "messages" | "files";
const searchScopes: { id: SearchScope; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "mine", label: "Your prompts" },
  { id: "results", label: "Results" },
  { id: "messages", label: "Messages" },
  { id: "files", label: "Files" },
];
export function SearchWorkspace({
  agents,
  folders,
  onOpen,
  onConversation,
  initialAgent = "",
  initialScope = "all",
  userName,
  onProfile,
  onReplyPrompt,
}: {
  onReplyPrompt?: (prompt: PromptReply) => void;
  initialAgent?: string;
  initialScope?: SearchScope;
  userName: string;
  onProfile: (a: Agent) => void;
  agents: Agent[];
  folders: FolderType[];
  onOpen: (a: Artifact) => void;
  onConversation: (conversation: string, message?: string) => void;
}) {
  const shownKey = "search:" + JSON.stringify([initialScope, initialAgent]);
  const shown = cachedView<{
    query: string;
    scope: SearchScope;
    category: FeedCategory | "";
    agent: string;
    folder: string;
    from: string;
    to: string;
    result: SearchResults | null;
    resultQuery: string;
  }>(shownKey);
  const [query, setQuery] = useState(shown?.query ?? ""),
    [scope, setScope] = useState<SearchScope>(shown?.scope ?? initialScope),
    [category, setCategory] = useState<FeedCategory | "">(
      shown?.category ?? "",
    ),
    [agent, setAgent] = useState(shown?.agent ?? initialAgent),
    [folder, setFolder] = useState(shown?.folder ?? ""),
    [from, setFrom] = useState(shown?.from ?? ""),
    [to, setTo] = useState(shown?.to ?? ""),
    [result, setResult] = useState<SearchResults | null>(shown?.result ?? null),
    [resultQuery, setResultQuery] = useState(shown?.resultQuery ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [recent, setRecent] = useState(() => recentSearches(viewOwner()));
  const searchRequest = useRef(0);
  const searched = useRef(!!shown?.result);
  // Search state belongs to the account that searched; it is never cached
  // for another account that signs in while this view is still mounted.
  const searchOwner = useRef(viewOwner());
  useEffect(() => {
    cacheView(
      shownKey,
      {
        query,
        scope,
        category,
        agent,
        folder,
        from,
        to,
        result,
        resultQuery,
      },
      searchOwner.current,
    );
  }, [query, scope, category, agent, folder, from, to, result, resultQuery]);
  useEffect(
    () => () => {
      searchRequest.current++;
    },
    [],
  );
  const kind =
    scope === "results"
      ? "markdown"
      : scope === "messages"
        ? "message"
        : scope === "files"
          ? "file"
          : "";
  async function run(append = false, text = query) {
    if (!text.trim() || scope === "mine") return;
    const request = ++searchRequest.current;
    searched.current = true;
    setBusy(true);
    setError("");
    if (!append) setResult(null);
    try {
      const query: RouteInput<typeof workspaceApi.search>["query"] = {
        q: text,
        scope: "all",
        category: category || undefined,
        kind,
        agent,
        project: folder || undefined,
      };
      if (from) query.from = String(Date.parse(from));
      if (to) query.to = String(Date.parse(to) + 86400000 - 1);
      if (append && result?.next) query.before = String(result.next);
      const r = await callRoute(
        workspaceApi.search,
        { query },
        executionSourceId(),
      );
      if (
        request !== searchRequest.current ||
        searchOwner.current !== viewOwner()
      )
        return;
      setResultQuery(text);
      if (!append) {
        rememberSearch(searchOwner.current, text.trim());
        setRecent(recentSearches(searchOwner.current));
      }
      setResult((previous) =>
        append
          ? {
              ...r,
              items: [
                ...new Map(
                  [...(previous?.items ?? []), ...r.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ],
            }
          : r,
      );
    } catch (e) {
      if (request === searchRequest.current) setError((e as Error).message);
    } finally {
      if (request === searchRequest.current) setBusy(false);
    }
  }
  useEffect(() => {
    searchRequest.current++;
    setBusy(false);
    if (scope !== "mine" && searched.current && query.trim()) void run();
  }, [scope, category, agent, folder, from, to]);
  const rerun = useRef(() => {});
  rerun.current = () => {
    if (resultQuery.trim()) void run(false, resultQuery);
  };
  useEffect(() => {
    const refresh = () => rerun.current();
    window.addEventListener("loop-refresh", refresh);
    return () => window.removeEventListener("loop-refresh", refresh);
  }, []);
  const groups: { key: string; items: SearchItem[] }[] = [];
  for (const item of result?.items || []) {
    const key = item.conversation_id || item.id;
    const group = groups.find((g) => g.key === key);
    if (group) group.items.push(item);
    else groups.push({ key, items: [item] });
  }
  async function openResult(r: SearchItem) {
    try {
      if (r.message_id || r.id.startsWith("message:")) {
        if (r.conversation_id)
          onConversation(r.conversation_id, r.message_id || r.id.slice(8));
      } else
        onOpen(
          await callRoute(
            workspaceApi.artifactDetail,
            { params: { id: r.id.slice(9) } },
            executionSourceId(),
          ),
        );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const agentMatches =
    scope === "all" && !category
      ? matchingAgents(agents, query, { agent, folder })
      : [];
  const active = [!!category, !!agent, !!folder, !!from, !!to].filter(
    Boolean,
  ).length;
  return (
    <>
      <form
        className="search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          void run();
        }}
      >
        <Search size={20} aria-hidden="true" />
        <input
          {...literalEntry}
          type="search"
          enterKeyHint="search"
          aria-label="Search everything"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            scope === "mine"
              ? "Search your prompts…"
              : "Search agents, threads, results and files…"
          }
        />
        {query.length > 0 && (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              searchRequest.current++;
              searched.current = false;
              setQuery("");
              setResult(null);
              setResultQuery("");
              setError("");
              setBusy(false);
              e.currentTarget.form?.querySelector("input")?.focus();
            }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
        {busy && <span className="field-hint">Finding…</span>}
      </form>
      <div
        className="chip-row search-scopes"
        role="tablist"
        aria-label="Search in"
      >
        {searchScopes.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className="chip"
            aria-selected={scope === s.id}
            onClick={() => setScope(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {scope !== "mine" && (
        <div className="chip-row search-refine">
          <label className="chip chip-select">
            <span className="sr-only">Feed category</span>
            <select
              aria-label="Search category"
              value={category}
              onChange={(e) => setCategory(e.target.value as FeedCategory | "")}
            >
              <option value="">All Feed categories</option>
              {feedCategories.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="chip chip-select">
            <span className="sr-only">Project</span>
            <select
              aria-label="Search project"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            >
              <option value="">Any project</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {folderPath(f.id, folders)}
                </option>
              ))}
            </select>
          </label>
          <label className="chip chip-select">
            <span className="sr-only">Agent</span>
            <select
              aria-label="Search agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            >
              <option value="">Any agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.name}
                </option>
              ))}
            </select>
          </label>
          <details className="search-dates">
            <summary className="chip">Dates{from || to ? " ·" : ""}</summary>
            <div className="search-filters">
              <label>
                From (UTC)
                <input
                  aria-label="From date"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                Through (UTC)
                <input
                  aria-label="Through date (UTC)"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          </details>
          {active > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setCategory("");
                setAgent("");
                setFolder("");
                setFrom("");
                setTo("");
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
      {agentMatches.length > 0 && (
        <section className="settings-navigation" aria-label="Matching agents">
          <h3>Agents</h3>
          <div className="project-agents settings-list">
            {agentMatches.map((a) => (
              <button
                className="project-agent"
                key={a.id}
                onClick={() => onProfile(a)}
              >
                <span>
                  <strong>@{a.name}</strong>
                  <Badge provider={a.provider} />
                  <small>{a.model}</small>
                </span>
                <ArrowUpRight size={18} />
              </button>
            ))}
          </div>
        </section>
      )}
      {error && <p className="error">{error}</p>}
      {scope === "mine" ? (
        <PersonalProfile
          embedded
          query={query}
          name={userName}
          agents={agents}
          onAgent={onProfile}
          onConversation={onConversation}
          onReply={onReplyPrompt}
        />
      ) : busy && !result ? (
        <p className="field-hint" role="status">
          Searching…
        </p>
      ) : result ? (
        <>
          {result.mode === "hybrid" && result.pending > 0 && (
            <p className="field-hint">
              {result.pending} items waiting to be indexed.
            </p>
          )}
          {groups.length ? (
            groups.map(({ key, items }) => {
              const first = items[0];
              return (
                <article className="search-result" key={key}>
                  <div className="subline">
                    <Badge provider={first.provider} />
                    <button
                      className="text-button"
                      disabled={!first.agent_id}
                      onClick={() => {
                        const agent = agents.find(
                          (a) => a.id === first.agent_id,
                        );
                        if (agent) onProfile(agent);
                      }}
                    >
                      <strong>@{first.name || "workspace"}</strong>
                    </button>
                    <span>
                      {new Date(first.created_at).toLocaleDateString()}
                    </span>
                    <small>
                      {first.folder_id
                        ? folderPath(first.folder_id, folders)
                        : "Unfiled"}
                    </small>
                  </div>
                  <h3>
                    <button
                      type="button"
                      onClick={() => void openResult(first)}
                    >
                      {first.title}
                    </button>
                  </h3>
                  {items.slice(0, 3).map((r) => (
                    <button
                      type="button"
                      key={r.id}
                      className="search-hit"
                      onClick={() => void openResult(r)}
                    >
                      <small>
                        {r.kind === "message"
                          ? "Message"
                          : r.kind === "markdown"
                            ? "Result"
                            : r.kind}
                      </small>
                      <span className="search-snippet">
                        <SearchExcerpt text={r.snippet} query={resultQuery} />
                      </span>
                    </button>
                  ))}
                  {items.length > 3 && (
                    <p className="field-hint">
                      {items.length - 3} more matches in this thread
                    </p>
                  )}
                </article>
              );
            })
          ) : !agentMatches.length ? (
            <Empty title="Nothing found yet.">
              Try a shorter phrase or adjust your filters.
            </Empty>
          ) : null}
          {result.next && (
            <button className="secondary" onClick={() => run(true)}>
              More results
            </button>
          )}
        </>
      ) : recent.length ? (
        <section className="recent-searches" aria-label="Recent searches">
          <h2 className="section-title">Recent</h2>
          <ul>
            {recent.map((text) => (
              <li key={text}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery(text);
                    void run(false, text);
                  }}
                >
                  <Search size={16} aria-hidden="true" /> {text}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              clearRecentSearches(searchOwner.current);
              setRecent([]);
            }}
          >
            Clear recent searches
          </button>
        </section>
      ) : (
        <Empty title="Your work, within reach.">
          Search threads, results and files. Choose “Your prompts” to find
          something you asked for.
        </Empty>
      )}
    </>
  );
}
/**
 * One import job. The original export lives in the object store of whichever
 * source ran the import, so its link must keep that source's routing.
 */
export function ImportJobRow({
  job,
  onReload,
}: {
  job: Pick<
    RouteResponse<typeof workspaceApi.importList>[number],
    "id" | "provider" | "status" | "summary"
  >;
  onReload: () => Promise<void> | void;
}) {
  const s = parse<
    Partial<RouteResponse<typeof workspaceApi.importPreview>["summary"]>
  >(job.summary, {});
  const done = s.completed || 0;
  const total = s.conversations || 0;
  const running = ["running", "queued"].includes(job.status);
  return (
    <div className="settings-import-job">
      <div>
        <strong>
          {job.provider === "openai" ? "ChatGPT" : "Claude"} export
        </strong>
        <small>
          {done} of {total} conversations
        </small>
        <SettingsProgress
          label="Import progress"
          value={done}
          total={total}
          running={running}
        />
      </div>
      <SettingsPill
        tone={
          job.status === "completed" ? "ready" : running ? "attention" : "muted"
        }
      >
        {job.status === "completed"
          ? "Done"
          : job.status[0].toUpperCase() + job.status.slice(1)}
      </SettingsPill>
      <div className="actions">
        {running ? (
          <button
            onClick={async () => {
              await callRoute(
                workspaceApi.importCancel,
                { params: { id: job.id }, body: {} },
                executionSourceId(),
              );
              await onReload();
            }}
          >
            Cancel
          </button>
        ) : (
          job.status !== "completed" && (
            <button
              onClick={async () => {
                await callRoute(
                  workspaceApi.importStart,
                  { params: { id: job.id }, body: {} },
                  executionSourceId(),
                );
                await onReload();
              }}
            >
              Start / resume safely
            </button>
          )
        )}
        {s.objectId && (
          <FileLink
            url={routeUrl(
              workspaceApi.objectFile,
              { params: { id: s.objectId } },
              executionSourceId(),
            )}
          >
            Original export
          </FileLink>
        )}
      </div>
    </div>
  );
}
export function ImportSheet({
  onClose,
  onChange,
}: {
  onClose: () => void;
  onChange: () => void;
}) {
  const [jobs, setJobs] = useState<
      RouteResponse<typeof workspaceApi.importList>
    >([]),
    [preview, setPreview] = useState<RouteResponse<
      typeof workspaceApi.importPreview
    > | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setJobs(await callRoute(workspaceApi.importList, {}, executionSourceId()));
  }
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, []);
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const file = new FormData(e.currentTarget).get("file");
      if (!(file instanceof Blob)) throw new Error("Choose an export file");
      const d = await callRoute(
        workspaceApi.importPreview,
        { body: {}, file },
        executionSourceId(),
      );
      setPreview(d);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Import conversations" onClose={onClose}>
      <p className="settings-intro">Bring your ChatGPT or Claude history.</p>
      <details className="settings-details">
        <summary>How to export your chats</summary>
        <p className="field-hint">
          In ChatGPT, open Settings → Data controls → Export data. In Claude’s
          web app, open Settings → Privacy → Export data. Download the export
          from the provider’s email, save it to Files, then select it here.
          Export availability depends on your account.
        </p>
      </details>
      <form onSubmit={upload}>
        <label className="settings-file-field">
          Export ZIP or conversations.json
          <input type="file" name="file" accept=".zip,.json" required />
        </label>
        <p className="field-hint">
          Up to 30 MB compressed / 100 MB expanded. Nothing is sent to a model,
          and your original files are retained privately.
        </p>
        <button className="primary" disabled={busy}>
          <Upload size={17} />
          {busy ? "Checking export…" : "Preview import"}
        </button>
      </form>
      {preview && (
        <div className="settings-card">
          <h3>{preview.provider === "openai" ? "ChatGPT" : "Claude"} export</h3>
          <p className="muted">
            {preview.summary.conversations} conversations ·{" "}
            {preview.summary.messages} messages · {preview.summary.attachments}{" "}
            attached files
          </p>
          {preview.summary.titles?.map((t: string) => (
            <p key={t} className="field-hint">
              {t}
            </p>
          ))}
          {preview.summary.warnings?.map((w: string) => (
            <p key={w} className="field-hint">
              {w}
            </p>
          ))}
          {preview.status !== "completed" && (
            <button
              className="primary"
              onClick={async () => {
                try {
                  await callRoute(
                    workspaceApi.importStart,
                    { params: { id: preview.id }, body: {} },
                    executionSourceId(),
                  );
                  setPreview(null);
                  await load();
                  onChange();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Import these conversations
            </button>
          )}
          {preview.duplicate && (
            <p className="field-hint">
              Already uploaded. Existing messages will not be duplicated.
            </p>
          )}
        </div>
      )}
      {error && (
        <SettingsNote
          icon={TriangleAlert}
          tone="attention"
          role="alert"
          title="Could not read that export"
        >
          {error}
        </SettingsNote>
      )}
      {!!jobs.length && (
        <SettingsSection title="Import history">
          <SettingsList>
            {jobs.map((j) => (
              <ImportJobRow
                key={j.id}
                job={j as RouteResponse<typeof workspaceApi.importList>[number]}
                onReload={load}
              />
            ))}
          </SettingsList>
        </SettingsSection>
      )}
    </Sheet>
  );
}
export function SearchSettings({
  connections,
  onClose,
}: {
  connections: Connection[];
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [connection, setConnection] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    void callRoute(workspaceApi.preferences, {}, executionSourceId())
      .then((p) => {
        setEnabled(!!p.embedding_enabled);
        setConnection(p.embedding_connection || "");
      })
      .catch((e) => setError(e.message));
  }, []);
  const embedding = connections.filter(
    (c) => c.provider === "openai" && c.status === "connected",
  );
  const chosen = embedding.find((c) => c.id === connection);
  return (
    <Sheet title="Search preferences" onClose={onClose}>
      <p className="settings-intro">How Loop finds your past work.</p>
      <SettingsList>
        <SettingsRow
          icon={Search}
          title="Keyword search"
          description="Always on · never leaves this server"
          state={<SettingsPill tone="ready">On</SettingsPill>}
        />
        <SettingsToggle
          icon={Sparkles}
          title="Enable semantic search"
          description="Finds related ideas by meaning"
          checked={enabled}
          onChange={setEnabled}
        />
      </SettingsList>
      {enabled && (
        <SettingsSection title="Semantic search">
          <SettingsList>
            <label className="settings-select-row">
              <span className="settings-row-icon">
                <Cpu size={20} aria-hidden="true" />
              </span>
              <span>
                <strong>Embedding account</strong>
                <small>
                  {chosen ? "Sends text to OpenAI" : "Private to this server"}
                </small>
              </span>
              <select
                value={connection}
                onChange={(e) => setConnection(e.target.value)}
              >
                <option value="">Local model · private, no API key</option>
                {embedding.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </SettingsList>
        </SettingsSection>
      )}
      {/* The index banner follows the server's own status, not this page's
          unsaved toggle, so preparation and failures stay visible. */}
      <SearchIndexStatus />
      <details className="settings-details">
        <summary>How semantic search works</summary>
        <p className="field-hint">
          A local model is downloaded once and your text stays on this server.
          Indexing runs in the background. Turning semantic search off deletes
          the stored vectors.
        </p>
      </details>
      {chosen && (
        <SettingsNote
          icon={TriangleAlert}
          tone="attention"
          title="This account sends your text to OpenAI"
        >
          It may incur charges. The local model keeps everything on this server.
        </SettingsNote>
      )}
      {error && (
        <SettingsNote
          icon={TriangleAlert}
          tone="attention"
          role="alert"
          title="Could not save your preference"
        >
          {error}
        </SettingsNote>
      )}
      <button
        className="primary"
        onClick={async () => {
          try {
            await callRoute(
              workspaceApi.preferencesUpdate,
              {
                body: {
                  embeddingEnabled: enabled,
                  connectionId: connection || null,
                },
              },
              executionSourceId(),
            );
            onClose();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Save preference
      </button>
    </Sheet>
  );
}
