import { useEffect, useState } from "react";
import { api, parse } from "./api";
import { Sheet } from "./components";
import type { Folder } from "../shared/types";
export function Memory({
  folders,
  onClose,
}: {
  folders: Folder[];
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [project, setProject] = useState(""),
    [source, setSource] = useState<any>(null);
  const load = () =>
    api("/memory")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    const requested = new URLSearchParams(location.search).get("memory");
    if (requested)
      void api("/memory/sources/" + requested)
        .then(setSource)
        .catch((e) => setError(e.message));
  }, []);
  const change = async (scope: string, enabled: boolean) => {
    try {
      await api("/memory/policy", { scope, enabled }, "PUT");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const isOn = (scope: string) =>
    data?.policies.find((p: any) => p.scope === scope)?.enabled !== 0;
  return (
    <Sheet title="Shared memory" onClose={onClose}>
      <div className="native-settings">
        <p>
          Included conversations and pinned notes help agents recall prior work
          with source citations. Removing shared memory retains the original
          conversation and context already delivered to agents.
        </p>
        {error && <p role="alert">{error}</p>}
        {data && (
          <>
            <p role="status">
              {data.readiness.ready
                ? "Semantic memory ready"
                : "Lexical fallback · semantic index unavailable"}{" "}
              · {data.backlog} pending updates
            </p>
            <label className="native-toggle">
              <input
                type="checkbox"
                checked={isOn("workspace")}
                onChange={(e) => void change("workspace", e.target.checked)}
              />
              Enable shared recall
            </label>
            {folders
              .filter((f) => f.kind === "project")
              .map((f) => (
                <label key={f.id} className="native-toggle">
                  <input
                    type="checkbox"
                    checked={isOn("project:" + f.id)}
                    onChange={(e) =>
                      void change("project:" + f.id, e.target.checked)
                    }
                  />
                  {f.name}
                </label>
              ))}
            <h3>Pin a note</h3>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Note
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={5}
              />
            </label>
            <label>
              Scope
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">Promoted workspace note</option>
                {folders
                  .filter((f) => f.kind === "project")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={!title.trim() || !content.trim()}
              onClick={() =>
                void api("/memory/notes", {
                  title,
                  content,
                  projectId: project || null,
                })
                  .then(() => {
                    setTitle("");
                    setContent("");
                    return load();
                  })
                  .catch((e) => setError(e.message))
              }
            >
              Pin note
            </button>
            <h3>Sources</h3>
            {data.sources.map((s: any) => (
              <div className="native-card" key={s.id}>
                <button
                  disabled={!!s.tombstone || !s.eligible}
                  onClick={() =>
                    void api("/memory/sources/" + s.id)
                      .then(setSource)
                      .catch((e) => setError(e.message))
                  }
                >
                  {s.title}
                </button>
                <small>
                  Revision {s.revision} ·{" "}
                  {s.tombstone
                    ? "Removed"
                    : !s.eligible
                      ? "Excluded"
                      : s.indexed_revision === s.revision
                        ? "Indexed"
                        : "Pending index"}
                </small>
                {!s.tombstone && (
                  <button
                    onClick={() =>
                      void api("/memory/sources/" + s.id, {}, "DELETE")
                        .then(load)
                        .catch((e) => setError(e.message))
                    }
                  >
                    Remove from shared memory
                  </button>
                )}
              </div>
            ))}
          </>
        )}
        {source && (
          <div className="native-card">
            <h3>{source.title}</h3>
            <p>
              {source.role} · revision {source.revision}
              {source.truncated ? " · truncated excerpt" : ""}
            </p>
            {source.kind === "note" ? (
              <>
                <label>
                  Note title
                  <input
                    value={source.title}
                    onChange={(e) =>
                      setSource({ ...source, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  Note content
                  <textarea
                    aria-label="Note content"
                    value={source.content}
                    rows={6}
                    onChange={(e) =>
                      setSource({ ...source, content: e.target.value })
                    }
                  />
                </label>
                <button
                  onClick={() =>
                    void api(
                      "/memory/notes/" + source.id,
                      {
                        revision: source.revision,
                        title: source.title,
                        content: source.content,
                      },
                      "PATCH",
                    )
                      .then(() => {
                        setSource(null);
                        return load();
                      })
                      .catch((e) => setError(e.message))
                  }
                >
                  Save note revision
                </button>
              </>
            ) : (
              <pre className="memory-excerpt">{source.content}</pre>
            )}
            {source.conversation_id && (
              <a href={source.link}>Open original message</a>
            )}
            <button onClick={() => setSource(null)}>Close source</button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
export function MemoryUsed({ runId }: { runId: string }) {
  const [receipt, setReceipt] = useState<any>(null),
    [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened) void api("/runs/" + runId + "/memory").then(setReceipt);
  }, [runId, opened]);
  return (
    <details onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>Memory used</summary>
      {receipt && (
        <>
          <p>
            {receipt.mode} · {receipt.tokens} estimated tokens
          </p>
          {parse<any[]>(receipt.sources, []).map((s) => (
            <p key={s.id}>
              <a href={s.link}>{s.title}</a> · {s.role} · revision {s.revision}
            </p>
          ))}
        </>
      )}
    </details>
  );
}
export function NativeConversation({ id }: { id: string }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [include, setInclude] = useState(true);
  useEffect(() => {
    const load = () =>
      api("/conversations/" + id + "/native")
        .then((v) => {
          setData(v);
          setInclude(v.memoryIncluded);
        })
        .catch((e) => setError(e.message));
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [id]);
  if (!data) return null;
  return (
    <details className="native-conversation">
      <summary>
        {data.backend === "hapi"
          ? `${data.environment?.name || "Execution environment"} · ${data.flavor || "native"} · ${data.environment?.state || "waiting"}`
          : "Conversation memory"}
      </summary>
      {error && <p role="alert">{error}</p>}
      <label className="native-toggle">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) => {
            const value = e.target.checked;
            void api(
              "/memory/policy",
              { scope: "conversation:" + id, enabled: value },
              "PUT",
            )
              .then(() => setInclude(value))
              .catch((e) => setError(e.message));
          }}
        />
        Include in shared memory
      </label>
      {data.backend === "hapi" && (
        <>
          <p>
            {data.billing?.requiredAuth === "chatgpt"
              ? "ChatGPT authentication required · API fallback disabled"
              : "Native Claude authentication"}
            <br />
            Thread: {data.threadId || "Not yet established"}
          </p>
          {(data.pending || []).map((r: any) => (
            <QueuedNative key={r.id} run={r} />
          ))}
          {data.dispatches.map((d: any) => (
            <p key={d.run_id}>
              <strong>{d.state.replaceAll("-", " ")}</strong>
              {d.cancel_requested
                ? " · cancellation pending acknowledgement"
                : ""}
              {d.error && (
                <>
                  <br />
                  {d.error}
                </>
              )}
            </p>
          ))}
          <div className="native-actions">
            <button
              onClick={() =>
                void api("/conversations/" + id + "/reconcile", {}).catch((e) =>
                  setError(e.message),
                )
              }
            >
              Reconcile status
            </button>
            <button
              onClick={() =>
                void api("/conversations/" + id + "/resume-native", {}).catch(
                  (e) => setError(e.message),
                )
              }
            >
              Resume native thread
            </button>
            <button
              onClick={() =>
                void api("/conversations/" + id + "/release-native", {}).catch(
                  (e) => setError(e.message),
                )
              }
            >
              Release idle process
            </button>
          </div>
        </>
      )}
    </details>
  );
}

function QueuedNative({ run }: { run: any }) {
  const [input, setInput] = useState(run.input),
    [notice, setNotice] = useState("");
  return (
    <div className="native-card">
      <label>
        Waiting for execution
        <textarea value={input} onChange={(e) => setInput(e.target.value)} />
      </label>
      <div className="native-actions">
        <button
          onClick={() =>
            void api("/runs/" + run.id + "/queued-input", { input }, "PATCH")
              .then(() => setNotice("Queued prompt updated"))
              .catch((e) => setNotice(e.message))
          }
        >
          Save queued prompt
        </button>
        <button
          onClick={() =>
            void api("/runs/" + run.id + "/cancel", {})
              .then(() => setNotice("Cancelled before dispatch"))
              .catch((e) => setNotice(e.message))
          }
        >
          Cancel queued prompt
        </button>
      </div>
      <p role="status">{notice}</p>
    </div>
  );
}
