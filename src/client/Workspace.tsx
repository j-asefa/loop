import { SearchExcerpt } from "./SearchExcerpt";
import { capabilities } from "./capabilities";
import { useEffect, useState, useRef, type FormEvent } from "react";
import {
  Folder,
  FileText,
  Plus,
  ChevronRight,
  Bookmark,
  Search,
  FolderInput,
  ArrowUpRight,
  Undo2,
  Download,
  Upload,
  Check,
} from "lucide-react";
import { api, parse, authorizedFetch } from "./api";
import { Sheet, Empty, Badge } from "./components";
import { FileLink } from "./FilePreview";
import type {
  Artifact,
  Folder as FolderType,
  Agent,
  Connection,
} from "../shared/types";
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
            const created = await api<FolderType>(
              existing ? "/folders/" + existing.id : "/folders",
              {
                path: f.get("path") || undefined,
                name: f.get("name"),
                kind: existing?.kind || kind,
                parentId: f.get("parent") || null,
              },
              existing ? "PATCH" : "POST",
            );
            onCreated(
              existing
                ? {
                    ...existing,
                    name: String(f.get("name")),
                    parent_id: String(f.get("parent") || "") || null,
                  }
                : created,
            );
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
              .filter((f) => f.id !== existing?.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </label>
        {capabilities.localProjects && (
          <>
            <label>
              Desktop directory
              <input
                name="path"
                defaultValue={existing?.path}
                placeholder="/Users/you/projects/my-project"
                maxLength={4096}
              />
            </label>
            <p className="note">
              Native agents inherit the nearest project directory. Existing
              conversations keep their original directory and native settings.
            </p>
          </>
        )}
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
  initialResult?: any;
  item: Artifact;
  folders: FolderType[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [destination, setDestination] = useState(item.folder_id || ""),
    [command, setCommand] = useState(""),
    [result, setResult] = useState<any>(initialResult || null),
    [error, setError] = useState("");
  async function move(natural = false) {
    try {
      const r = await api(
        `/artifacts/${item.id}/move`,
        natural ? { command } : { folderId: destination || null },
      );
      setResult(r);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
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
              href={`/?folder=${result.folderId || "inbox"}`}
            >
              Open folder
              <ArrowUpRight size={16} />
            </a>
            <button
              onClick={async () => {
                try {
                  await api(`/operations/${result.operation}/undo`, {});
                  setResult(null);
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
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
              <option value="">Workspace inbox</option>
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
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Put this in Research Radar / Workflows"
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
    [items, setItems] = useState<Artifact[]>([]),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const request = useRef(0);
  async function load(append = false) {
    const ticket = ++request.current;
    // Keep existing rows mounted during background refreshes.
    if (!append && !items.length) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (!embedded && view === "pinned") params.set("pinned", "1");
      else if (embedded || view === "folders")
        params.set("folder", folder || "inbox");
      if (append && next) params.set("before", String(next));
      const r = await api("/artifacts?" + params);
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
      await api(
        "/artifacts/" + a.id,
        { pinned: !a.pinned, version: a.version },
        "PATCH",
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const current = folders.find((f) => f.id === folder);
  return (
    <>
      {current && !embedded && view === "folders" && (
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
              .filter((f) => f.parent_id === (folder || null))
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
                    <Badge provider={a.provider} />
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
  const [status, setStatus] = useState<any>(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      void api("/search/status")
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
        <span>
          {status.indexed} of {status.total} items indexed
        </span>
      )}
    </div>
  );
}
export function SearchWorkspace({
  agents,
  folders,
  onOpen,
  onConversation,
  initialAgent = "",
  onSearchSettings,
  onProfile,
}: {
  initialAgent?: string;
  onSearchSettings: () => void;
  onProfile: (a: Agent) => void;
  agents: Agent[];
  folders: FolderType[];
  onOpen: (a: Artifact) => void;
  onConversation: (conversation: string, message?: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState("all"),
    [kind, setKind] = useState(""),
    [agent, setAgent] = useState(initialAgent),
    [folder, setFolder] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [result, setResult] = useState<any>(null),
    [resultQuery, setResultQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const searchRequest = useRef(0);
  async function run(append = false) {
    if (!query.trim()) return;
    const request = ++searchRequest.current;
    setBusy(true);
    setError("");
    try {
      const p = new URLSearchParams({ q: query, scope, kind, agent, folder });
      if (from) p.set("from", String(Date.parse(from)));
      if (to) p.set("to", String(Date.parse(to) + 86400000 - 1));
      if (append && result?.next) p.set("before", String(result.next));
      const r = await api("/search?" + p);
      if (request !== searchRequest.current) return;
      setResultQuery(query);
      setResult((previous: any) =>
        append
          ? {
              ...r,
              items: [
                ...new Map(
                  [...previous.items, ...r.items].map((item: any) => [
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
    if (result && query.trim()) void run();
  }, [scope, kind, agent, folder, from, to]);
  return (
    <>
      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Search size={21} />
        <input
          aria-label="Search everything"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find that idea, answer, or artifact…"
        />
        <button className="primary" disabled={busy}>
          {busy ? "Finding…" : "Search"}
        </button>
      </form>
      <details className="search-filter-panel">
        <summary>
          Filters
          {[scope !== "all", !!agent, !!kind, !!folder, !!from, !!to].filter(
            Boolean,
          ).length > 0 &&
            ` · ${[scope !== "all", !!agent, !!kind, !!folder, !!from, !!to].filter(Boolean).length} active`}
        </summary>
        <div className="search-filters">
          <select
            aria-label="Search scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">All agents</option>
            <option value="running">Running agents</option>
            <option value="mine">My messages</option>
          </select>
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
          <select
            aria-label="Artifact type"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All types</option>
            {[
              "message",
              "markdown",
              "table",
              "diagram",
              "workflow",
              "chart",
              "file",
            ].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <select
            aria-label="Search project"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            <option value="">Any folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderPath(f.id, folders)}
              </option>
            ))}
          </select>
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
        <button
          className="text-button"
          onClick={() => {
            setScope("all");
            setAgent("");
            setKind("");
            setFolder("");
            setFrom("");
            setTo("");
          }}
        >
          Clear filters
        </button>
      </details>
      <div className="search-chips" aria-label="Active search filters">
        {scope !== "all" && (
          <button onClick={() => setScope("all")}>
            {scope === "mine" ? "Your messages" : "Running agents"} ×
          </button>
        )}
        {agent && (
          <button onClick={() => setAgent("")}>
            @{agents.find((a) => a.id === agent)?.name || "Agent"} ×
          </button>
        )}
        {kind && <button onClick={() => setKind("")}>{kind} ×</button>}
        {folder && (
          <button onClick={() => setFolder("")}>
            {folders.find((f) => f.id === folder)?.name || "Project"} ×
          </button>
        )}
        {from && <button onClick={() => setFrom("")}>From {from} ×</button>}
        {to && <button onClick={() => setTo("")}>Through {to} ×</button>}
      </div>
      <details className="search-settings-summary">
        <summary>Search options & index status</summary>
        <SearchIndexStatus />
        <button className="text-button" onClick={onSearchSettings}>
          Configure semantic search
        </button>
      </details>
      {error && <p className="error">{error}</p>}
      {result ? (
        <>
          <p className="field-hint">
            {result.detail}
            {result.mode === "hybrid" &&
              result.pending > 0 &&
              ` ${result.pending} items waiting to be indexed.`}
          </p>
          {result.items.length ? (
            result.items.map((r: any) => (
              <div
                className="search-result"
                key={r.id}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (
                    e.target === e.currentTarget &&
                    ["Enter", " "].includes(e.key)
                  ) {
                    e.preventDefault();
                    e.currentTarget.click();
                  }
                }}
                onClick={async () => {
                  try {
                    if (r.message_id || r.id.startsWith("message:"))
                      onConversation(
                        r.conversation_id,
                        r.message_id || r.id.slice(8),
                      );
                    else onOpen(await api("/artifacts/" + r.id.slice(9)));
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <div className="subline">
                  <Badge provider={r.provider} />
                  <button
                    className="text-button"
                    disabled={!r.agent_id}
                    onClick={(e) => {
                      e.stopPropagation();
                      const agent = agents.find((a) => a.id === r.agent_id);
                      if (agent) onProfile(agent);
                    }}
                  >
                    <strong>@{r.name || "workspace"}</strong>
                  </button>
                  <span>{new Date(r.created_at).toLocaleDateString()}</span>
                </div>
                <h3>{r.title}</h3>
                <p className="search-snippet">
                  <SearchExcerpt text={r.snippet} query={resultQuery} />
                </p>
                <small>
                  {r.kind === "message"
                    ? "Conversation"
                    : r.kind === "markdown"
                      ? "Output"
                      : r.kind}{" "}
                  ·{" "}
                  {r.folder_id
                    ? folderPath(r.folder_id, folders)
                    : "Workspace inbox"}
                  <ArrowUpRight size={13} />
                </small>
              </div>
            ))
          ) : (
            <Empty title="Nothing found yet.">
              Try a shorter phrase or adjust the filters.
            </Empty>
          )}
          {result.next && (
            <button className="secondary" onClick={() => run(true)}>
              More results
            </button>
          )}
        </>
      ) : (
        <Empty title="Your work, within reach.">
          Search ideas, conversations, and everything your agents have made.
          Keywords work immediately; turn on semantic search in settings to find
          related ideas.
        </Empty>
      )}
    </>
  );
}
export function ImportSheet({
  onClose,
  onChange,
}: {
  onClose: () => void;
  onChange: () => void;
}) {
  const [jobs, setJobs] = useState<any[]>([]),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setJobs(await api("/imports"));
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
      const r = await authorizedFetch("/api/imports/preview", {
        method: "POST",
        body: new FormData(e.currentTarget),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setPreview(d);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Bring your history with you" onClose={onClose}>
      <p className="muted">
        Import a ChatGPT or Claude export. Your original conversations stay
        intact, and nothing is sent to a model by importing.
      </p>
      <details>
        <summary>How to export your chats</summary>
        <p className="note">
          In ChatGPT, open Settings → Data controls → Export data. In Claude’s
          web app, open Settings → Privacy → Export data. Download the export
          from the provider’s email, save it to Files, then select it here.
          Export availability depends on your account.
        </p>
      </details>
      <form onSubmit={upload}>
        <label>
          Export ZIP or conversations.json
          <input type="file" name="file" accept=".zip,.json" required />
        </label>
        <p className="field-hint">
          Up to 30 MB compressed / 100 MB expanded. Original files are retained
          privately.
        </p>
        <button className="primary" disabled={busy}>
          <Upload size={17} />
          {busy ? "Checking export…" : "Preview import"}
        </button>
      </form>
      {preview && (
        <div className="note">
          <h3>{preview.provider === "openai" ? "ChatGPT" : "Claude"} export</h3>
          <p>
            {preview.summary.conversations} conversations ·{" "}
            {preview.summary.messages} messages · {preview.summary.attachments}{" "}
            attached files
          </p>
          {preview.summary.titles?.map((t: string) => (
            <p key={t}>{t}</p>
          ))}
          {preview.summary.warnings?.map((w: string) => (
            <p key={w}>{w}</p>
          ))}
          {preview.status !== "completed" && (
            <button
              className="primary"
              onClick={async () => {
                try {
                  await api(`/imports/${preview.id}/start`, {});
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
            <p>Already uploaded. Existing messages will not be duplicated.</p>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <h3 className="section-title">Import history</h3>
      {jobs.map((j) => {
        const s = parse<any>(j.summary, {});
        return (
          <div className="connection-card" key={j.id}>
            <Badge provider={j.provider} />
            <p>
              {s.completed || 0} / {s.conversations} conversations · {j.status}
            </p>
            <div className="actions">
              {["running", "queued"].includes(j.status) ? (
                <button
                  onClick={async () => {
                    await api(`/imports/${j.id}/cancel`, {});
                    await load();
                  }}
                >
                  Cancel
                </button>
              ) : (
                j.status !== "completed" && (
                  <button
                    onClick={async () => {
                      await api(`/imports/${j.id}/start`, {});
                      await load();
                    }}
                  >
                    Start / resume safely
                  </button>
                )
              )}
              <FileLink url={"/api/objects/" + s.objectId}>
                Original export
              </FileLink>
            </div>
          </div>
        );
      })}
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
    void api("/preferences")
      .then((p) => {
        setEnabled(!!p.embedding_enabled);
        setConnection(p.embedding_connection || "");
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Sheet title="Search preferences" onClose={onClose}>
      <p>Keyword search always runs privately on this server.</p>
      <SearchIndexStatus />
      <p className="note">
        Local semantic search finds related ideas by meaning. It downloads a
        small model once, then keeps your text on this server. Indexing runs in
        the background. You can also choose an OpenAI API account; that sends
        text to OpenAI and may incur charges. Turning search off deletes stored
        vectors.
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable semantic search
      </label>
      <label>
        Embedding account
        <select
          value={connection}
          onChange={(e) => setConnection(e.target.value)}
        >
          <option value="">Local model · private, no API key</option>
          {connections
            .filter((c) => c.provider === "openai" && c.status === "connected")
            .map((c) => (
              <option value={c.id} key={c.id}>
                {c.label}
              </option>
            ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <button
        className="primary"
        onClick={async () => {
          try {
            await api("/preferences", {
              embeddingEnabled: enabled,
              connectionId: connection || null,
            });
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
