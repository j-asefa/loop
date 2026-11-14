import {
  ConversationId,
  RunId,
  MemorySourceId,
  ProjectId,
  parseId,
} from "../shared/contract-ids.js";
import { proseEntry } from "./textEntry";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useSourceRoute, useSourceId } from "./SourceContext";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { useEffect, useRef, useState } from "react";
import { Bookmark, Info, MessageSquare } from "lucide-react";
import { parse } from "./json";
import { readRoute } from "./api";
import { viewGeneration } from "./viewCache";
import {
  CollectionReadNotice,
  useCollectionRead,
  useProjectionQuery,
} from "./CollectionRead";
import { Sheet } from "./components";
import {
  SettingsList,
  SettingsNote,
  SettingsPill,
  SettingsSection,
  SettingsToggle,
} from "./SettingsUI";
import type { Folder } from "../shared/types";
type MemoryProps = { folders: Folder[]; onClose: () => void };
export function Memory(props: MemoryProps) {
  const source = useSourceId();
  return (
    <MemoryView key={JSON.stringify([viewGeneration(), source])} {...props} />
  );
}
function MemoryView({ folders, onClose }: MemoryProps) {
  const call = useSourceRoute(),
    apiSource = useSourceId();
  const statusRead = useProjectionQuery(
    workspaceApi.memoryStatus,
    {},
    { source: apiSource },
  );
  const data = statusRead.data;
  const [error, setError] = useState(""),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [project, setProject] = useState(""),
    [pinning, setPinning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("memory") || undefined,
  );
  const sourceRead = useProjectionQuery(
    workspaceApi.memorySource,
    selectedId
      ? { params: { id: MemorySourceId.parse(selectedId) } }
      : undefined,
    { source: apiSource },
  );
  const [draft, setDraft] =
    useState<RouteResponse<typeof workspaceApi.memorySource>>();
  const source = selectedId ? (draft ?? sourceRead.data ?? null) : null;
  const selection = useRef(0);
  const currentReads = useRef({ selectedId, sourceRead, statusRead });
  currentReads.current = { selectedId, sourceRead, statusRead };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = () =>
    mounted.current
      ? currentReads.current.statusRead.refresh()
      : Promise.resolve();
  function openSource(id: string) {
    selection.current++;
    setDraft(undefined);
    if (selectedId === id) void sourceRead.refresh(true);
    else setSelectedId(id);
  }
  function closeSource() {
    selection.current++;
    setSelectedId(undefined);
    setDraft(undefined);
  }
  async function saveNote() {
    if (!source || source.kind !== "note") return;
    const ticket = selection.current;
    try {
      await call(workspaceApi.memoryNoteUpdate, {
        params: { id: source.id },
        body: {
          revision: source.revision,
          title: source.title,
          content: source.content,
        },
      });
      if (!mounted.current) return;
      if (ticket === selection.current) closeSource();
      else if (currentReads.current.selectedId === source.id)
        void currentReads.current.sourceRead.refresh();
      await load();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const change = async (scope: string, enabled: boolean) => {
    try {
      await call(workspaceApi.memoryPolicy, { body: { scope, enabled } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const isOn = (scope: string) =>
    data?.policies.find((p) => p.scope === scope)?.enabled !== 0;
  const sourceState = (
    s: RouteResponse<typeof workspaceApi.memoryStatus>["sources"][number],
  ) =>
    s.tombstone
      ? { label: "Removed", tone: "muted" as const }
      : !s.eligible
        ? { label: "Excluded", tone: "muted" as const }
        : { label: "Saved", tone: "ready" as const };
  return (
    <Sheet title="Shared memory" onClose={onClose}>
      <div className="native-settings">
        <p className="settings-intro">
          What agents can recall across conversations.
        </p>
        <CollectionReadNotice
          error={statusRead.error && "Shared memory: " + statusRead.error}
          busy={statusRead.busy}
          retry={statusRead.retry}
        />
        <CollectionReadNotice
          error={sourceRead.error && "Saved source: " + sourceRead.error}
          busy={sourceRead.busy}
          retry={sourceRead.retry}
        />
        {selectedId && !source && (
          <button onClick={closeSource}>Close source</button>
        )}
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
              title="Local keyword search"
            >
              Saved sources are matched by keyword on this computer.
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
                      {...proseEntry}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                  <label>
                    Note
                    <textarea
                      {...proseEntry}
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
                      void call(workspaceApi.memoryNoteCreate, {
                        body: {
                          title,
                          content,
                          projectId: parseId(ProjectId, project || null),
                        },
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
                {data.sources.map((s) => {
                  const state = sourceState(s);
                  return (
                    <div className="memory-source" key={s.id}>
                      <button
                        type="button"
                        className="memory-source-open"
                        aria-label={s.title}
                        disabled={!!s.tombstone || !s.eligible}
                        onClick={() => openSource(s.id)}
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
                            void call(workspaceApi.memorySourceDelete, {
                              params: { id: s.id },
                              body: {},
                            })
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
                    {...proseEntry}
                    value={source.title}
                    onChange={(e) =>
                      setDraft({ ...source, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  Note content
                  <textarea
                    {...proseEntry}
                    aria-label="Note content"
                    value={source.content}
                    rows={6}
                    onChange={(e) =>
                      setDraft({ ...source, content: e.target.value })
                    }
                  />
                </label>
                <button className="primary" onClick={() => void saveNote()}>
                  Save note revision
                </button>
              </>
            ) : (
              <pre className="memory-excerpt">{source.content}</pre>
            )}
            <div className="actions">
              {"link" in source && source.conversation_id && (
                <a href={source.link}>Open original message</a>
              )}
              <button onClick={closeSource}>Close source</button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
type MemoryReceipt = Pick<
  RouteResponse<typeof workspaceApi.runMemory>,
  "mode" | "sources" | "tokens"
>;
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
    `${receipt.tokens.toLocaleString()} token${receipt.tokens === 1 ? "" : "s"} of context.`
  );
}
export function MemoryUsed({ runId }: { runId: string }) {
  const source = useSourceId();
  const [opened, setOpened] = useState(false);
  const receiptRead = useProjectionQuery(
    workspaceApi.runMemory,
    opened ? { params: { id: RunId.parse(runId) } } : undefined,
    { source },
  );
  const receipt = receiptRead.data;
  return (
    <details onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>Memory used</summary>
      <CollectionReadNotice
        error={receiptRead.error && "Memory used: " + receiptRead.error}
        busy={receiptRead.busy}
        retry={receiptRead.retry}
      />
      {receipt && (
        <>
          <p>{memoryReceiptText(receipt)}</p>
          {parse<
            {
              id: string;
              link: string;
              title: string;
              role: string;
              revision: number;
            }[]
          >(receipt.sources, []).map((s) => (
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
  const call = useSourceRoute(),
    sourceId = useSourceId();
  const recovery = useCollectionRead(JSON.stringify([sourceId, id]));
  const read = recovery.load;
  const [data, setData] = useState<RouteResponse<
      typeof workspaceApi.conversationMemory
    > | null>(null),
    [error, setError] = useState(""),
    [include, setInclude] = useState(true);
  const load = (manual = false) =>
    read(
      (signal, mode) =>
        readRoute(
          workspaceApi.conversationMemory,
          { params: { id: ConversationId.parse(id) } },
          sourceId,
          signal,
          undefined,
          mode,
        ),
      (value) => {
        setData(value);
        setInclude(value.memoryIncluded);
      },
      manual,
    );
  useEffect(() => {
    setData(null);
    const update = () => void load();
    const stopChanges = listenWorkspaceChanges("metadata", update, sourceId);
    void load();
    return () => {
      stopChanges();
    };
  }, [id, sourceId, read]);
  if (!data)
    return <CollectionReadNotice {...recovery} retry={() => void load(true)} />;
  return (
    <details className="native-conversation">
      <summary>Conversation memory</summary>
      <CollectionReadNotice {...recovery} retry={() => void load(true)} />
      {error && <p role="alert">{error}</p>}
      <label className="native-toggle">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) => {
            const value = e.target.checked;
            void call(workspaceApi.memoryPolicy, {
              body: { scope: "conversation:" + id, enabled: value },
            })
              .then(() => setInclude(value))
              .catch((e) => setError(e.message));
          }}
        />
        Include in shared memory
      </label>
    </details>
  );
}
