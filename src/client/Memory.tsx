import { surfaceFallback } from "./workspace-projections";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceApi, useSourceId, useProjectionRead } from "./SourceContext";
import { useEffect, useState } from "react";
import { Bookmark, Info, MessageSquare } from "lucide-react";
import { parse } from "./api";
import { Sheet } from "./components";
import {
  SettingsList,
  SettingsNote,
  SettingsPill,
  SettingsSection,
  SettingsToggle,
} from "./SettingsUI";
import type { Folder } from "../shared/types";
export function Memory({
  folders,
  onClose,
}: {
  folders: Folder[];
  onClose: () => void;
}) {
  const api = useSourceApi();
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [project, setProject] = useState(""),
    [pinning, setPinning] = useState(false),
    [source, setSource] = useState<any>(null);
  const load = () =>
    api("/memory")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    const requested = new URLSearchParams(location.search).get("memory");
    if (requested)
      void api(`/memory/sources/${requested}`)
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
  const sourceState = (s: any) =>
    s.tombstone
      ? { label: "Removed", tone: "muted" as const }
      : !s.eligible
        ? { label: "Excluded", tone: "muted" as const }
        : s.indexed_revision === s.revision
          ? { label: "Indexed", tone: "ready" as const }
          : { label: "Pending", tone: "muted" as const };
  return (
    <Sheet title="Shared memory" onClose={onClose}>
      <div className="native-settings">
        <p className="settings-intro">
          What agents can recall across conversations.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {data && (
          <>
            <SettingsList>
              <SettingsToggle
                icon={Bookmark}
                title="Enable shared recall"
                description="Agents cite the source they used"
                checked={isOn("workspace")}
                onChange={(next) => void change("workspace", next)}
              />
            </SettingsList>
            <SettingsNote
              icon={Info}
              role="status"
              title={
                data.readiness.ready
                  ? "Semantic memory ready"
                  : "Keyword matching for now"
              }
            >
              {(data.readiness.ready
                ? "Related ideas are matched by meaning."
                : "The semantic index is unavailable.") +
                " " +
                data.backlog +
                " pending updates."}
            </SettingsNote>
            <SettingsSection title="Projects included">
              <SettingsList>
                {folders
                  .filter((f) => f.kind === "project")
                  .map((f) => (
                    <SettingsToggle
                      key={f.id}
                      title={f.name}
                      checked={isOn("project:" + f.id)}
                      onChange={(next) => void change("project:" + f.id, next)}
                    />
                  ))}
              </SettingsList>
            </SettingsSection>
            <SettingsSection
              title="Sources"
              action={
                <button
                  type="button"
                  className="text-button"
                  aria-expanded={pinning}
                  onClick={() => setPinning(!pinning)}
                >
                  {pinning ? "Cancel" : "Pin a note"}
                </button>
              }
            >
              {pinning && (
                <div className="settings-card">
                  <label>
                    Title
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
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
                    className="primary"
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
                          setPinning(false);
                          return load();
                        })
                        .catch((e) => setError(e.message))
                    }
                  >
                    Pin note
                  </button>
                </div>
              )}
              <SettingsList>
                {data.sources.map((s: any) => {
                  const state = sourceState(s);
                  return (
                    <div className="memory-source" key={s.id}>
                      <button
                        type="button"
                        className="memory-source-open"
                        aria-label={s.title}
                        disabled={!!s.tombstone || !s.eligible}
                        onClick={() =>
                          void api(`/memory/sources/${s.id}`)
                            .then(setSource)
                            .catch((e) => setError(e.message))
                        }
                      >
                        <span className="settings-row-icon">
                          {s.kind === "note" ? (
                            <Bookmark size={20} aria-hidden="true" />
                          ) : (
                            <MessageSquare size={20} aria-hidden="true" />
                          )}
                        </span>
                        <span>
                          <strong>{s.title}</strong>
                          <small>
                            {s.kind === "note" ? "Note" : "Conversation"} ·
                            Revision {s.revision}
                          </small>
                        </span>
                      </button>
                      <SettingsPill tone={state.tone}>
                        {state.label}
                      </SettingsPill>
                      {!s.tombstone && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            void api(`/memory/sources/${s.id}`, {}, "DELETE")
                              .then(load)
                              .catch((e) => setError(e.message))
                          }
                        >
                          Remove from shared memory
                        </button>
                      )}
                    </div>
                  );
                })}
              </SettingsList>
              <p className="field-hint">
                Removing a source keeps the original conversation and anything
                already delivered to an agent.
              </p>
            </SettingsSection>
          </>
        )}
        {source && (
          <div className="settings-card">
            <h3>{source.title}</h3>
            <p className="muted">
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
                  className="primary"
                  onClick={() =>
                    void api(
                      `/memory/notes/${source.id}`,
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
            <div className="actions">
              {source.conversation_id && (
                <a href={source.link}>Open original message</a>
              )}
              <button onClick={() => setSource(null)}>Close source</button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
export type MemoryReceipt = { mode: string; sources: string; tokens: number };
/**
 * What saved memory was added to a run's prompt. The token figure is only
 * the added memory text (about four characters a token), not the run's usage.
 */
export function memoryReceiptText(receipt: MemoryReceipt) {
  const count = parse<unknown[]>(receipt.sources, []).length;
  if (receipt.mode === "not-used")
    return "No saved memory was added to this message.";
  if (receipt.mode === "disabled")
    return "Memory is turned off here, so none was added.";
  if (!count) return "No saved memory matched this message.";
  return (
    `Added ${count} saved source${count === 1 ? "" : "s"}, about ` +
    `${receipt.tokens.toLocaleString()} token${receipt.tokens === 1 ? "" : "s"} of context.` +
    (receipt.mode === "lexical-degraded"
      ? " Matched by keyword only: memory search was unavailable."
      : "")
  );
}
export function MemoryUsed({ runId }: { runId: string }) {
  const api = useSourceApi();
  const [receipt, setReceipt] = useState<any>(null),
    [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened) void api(`/runs/${runId}/memory`).then(setReceipt);
  }, [runId, opened]);
  return (
    <details onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>Memory used</summary>
      {receipt && (
        <>
          <p>{memoryReceiptText(receipt)}</p>
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
  const api = useSourceApi(),
    read = useProjectionRead(),
    sourceId = useSourceId();
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [include, setInclude] = useState(true);
  useEffect(() => {
    const load = () =>
      read(`/conversations/${id}/memory`)
        .then((v) => {
          setData(v);
          setInclude(v.memoryIncluded);
        })
        .catch((e) => setError(e.message));
    const stopChanges = listenWorkspaceChanges("metadata", load, sourceId);
    const stopFallback = surfaceFallback([sourceId], "workspace", 4000, load);
    void load();
    return () => {
      stopChanges();
      stopFallback();
    };
  }, [id, sourceId, read]);
  if (!data) return null;
  return (
    <details className="native-conversation">
      <summary>Conversation memory</summary>
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
    </details>
  );
}
