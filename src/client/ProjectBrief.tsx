import { useEffect, useRef, useState, type FormEvent } from "react";
import "./projectBrief.css";
import { apiInWorkspace } from "./api";
import {
  canGenerateBrief,
  canSelectBriefModel,
} from "../shared/brief-connections";
import { executionSourceId } from "./sourceRouting";
import { Sheet } from "./components";
import { ConnectionDetails } from "./ConnectionDetails";
import { ConnectionPicker, ModelPicker } from "./ConnectionPicker";
import { modelGroups } from "./modelChoices";
import { BriefAcknowledgements, briefSourceUrl } from "./briefView";
import type { Agent, Connection } from "../shared/types";
import type {
  BriefItems,
  BriefPage,
  BriefSource,
  BriefVersion,
  Item,
} from "../shared/briefs";

type Props = {
  projectId: string;
  initial: BriefPage;
  acknowledgements: BriefAcknowledgements;
  connections: Connection[];
  agents: Agent[];
  onNavigate: (url: string) => void;
  onChanged: (brief: BriefPage) => void;
};
type History = { items: BriefVersion[]; before: number | null };
export { ProjectBriefView } from "./ProjectBriefView";
import {
  ProjectBriefView,
  BriefItemCard as ItemCard,
} from "./ProjectBriefView";

function BriefSettings({
  page,
  connections,
  busy,
  save,
}: {
  page: BriefPage;
  connections: Connection[];
  busy: boolean;
  save: (value: BriefPage["settings"]) => void;
}) {
  const groups = modelGroups(connections.filter(canGenerateBrief)).map(
    (group) => ({
      ...group,
      models: group.models.filter((model) =>
        canSelectBriefModel(group.connection, model.id),
      ),
    }),
  );
  const [connection, setConnection] = useState(
    page.settings.connectionId || groups[0]?.connection.id || "",
  );
  const [model, setModel] = useState(page.settings.model || "");
  const group =
      groups.find((group) => group.connection.id === connection) ?? groups[0],
    chosen =
      group?.models.find((modelInfo) => modelInfo.id === model)?.id ||
      group?.models[0]?.id ||
      "";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save({
          enabled: true,
          connectionId: group?.connection.id ?? null,
          model: chosen,
          lastError: null,
        });
      }}
    >
      <p>
        A cited overview of decisions, questions and unfinished work, updated as
        your project changes.
      </p>
      <p className="muted">
        Choose a connection to generate this brief. Subscription connections use
        that account’s allowance; API connections use provider API billing.
      </p>
      <ConnectionPicker
        label="Connection"
        value={group?.connection.id ?? ""}
        disabled={busy}
        onChange={(value) => {
          setConnection(value);
          setModel("");
        }}
      >
        {!groups.length && (
          <option value="">No compatible connection available</option>
        )}
        {groups.map((group) => (
          <option key={group.connection.id} value={group.connection.id}>
            {group.connection.label}
          </option>
        ))}
      </ConnectionPicker>
      {group && (
        <>
          <ConnectionDetails connection={group.connection} />
          <ModelPicker
            models={group.models}
            value={chosen}
            onChange={setModel}
            disabled={busy}
          />
        </>
      )}
      {!groups.length && (
        <p>
          Connect a Codex or Claude Code subscription, or an OpenAI or Anthropic
          API connection, in Settings → Provider connections.
        </p>
      )}
      <div className="brief-actions">
        <button className="primary" disabled={busy || !chosen}>
          {page.settings.enabled ? "Save settings" : "Enable brief"}
        </button>
        {page.settings.enabled && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              save({
                enabled: false,
                connectionId: null,
                model: null,
                lastError: null,
              })
            }
          >
            Turn off
          </button>
        )}
      </div>
    </form>
  );
}

export function ProjectBrief({
  projectId,
  initial,
  acknowledgements,
  connections,
  agents,
  onNavigate,
  onChanged,
}: Props) {
  const [page, setPage] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [viewRecorded, setViewRecorded] = useState(false);
  const [sheet, setSheet] = useState<
    "goal" | "settings" | "history" | "decision" | "all" | "item" | null
  >(null);
  const [item, setItem] = useState<Item | null>(null),
    [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(""),
    [text, setText] = useState(""),
    [why, setWhy] = useState(""),
    [evidence, setEvidence] = useState("");
  const [choices, setChoices] = useState<BriefSource[]>([]),
    [all, setAll] = useState<BriefItems | null>(null),
    [allKind, setAllKind] = useState<Item["kind"]>("decision");
  const [versions, setVersions] = useState<History>({
    items: [],
    before: null,
  });
  const workspace = useRef(executionSourceId()).current,
    root = `/projects/${encodeURIComponent(projectId)}/brief`;
  const request = useRef(0),
    itemsRequest = useRef(0),
    historyRequest = useRef(0),
    locked = useRef(false),
    alive = useRef(true);
  const fetch = <T,>(path = "", body?: unknown, method?: string) =>
    apiInWorkspace<T>(root + path, workspace, body, method);
  const load = async () => {
    if (locked.current) return;
    const own = ++request.current;
    try {
      const next = await fetch<BriefPage>();
      if (alive.current && own === request.current) {
        setPage(next);
        setError("");
        onChanged(next);
      }
    } catch (error) {
      if (alive.current && own === request.current)
        setError((error as Error).message);
    }
  };
  useEffect(() => {
    alive.current = true;
    const refresh = () => void load(),
      visible = () => {
        if (document.visibilityState === "visible") refresh();
      };
    window.addEventListener("loop-refresh", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", visible);
    void load();
    return () => {
      alive.current = false;
      request.current++;
      window.removeEventListener("loop-refresh", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [projectId]);
  useEffect(() => {
    if (!page.settings.enabled && !viewRecorded) return;
    void acknowledgements
      .acknowledge(page.version, page.acknowledged_version, (version) =>
        fetch("/ack", { version }),
      )
      .catch((error) => {
        if (alive.current) setError(error.message);
      });
  }, [page, viewRecorded]);
  const mutate = async (path: string, body: unknown, method = "POST") => {
    if (locked.current) return;
    locked.current = true;
    request.current++;
    setBusy(true);
    setError("");
    try {
      const next = await fetch<BriefPage>(path, body, method);
      if (alive.current) {
        setPage(next);
        onChanged(next);
        setSheet(null);
        setAll(null);
      }
    } catch (error) {
      if (alive.current) setError((error as Error).message);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const author = (id: string) =>
    id === "you"
      ? "you"
      : agents.find((agent) => agent.id === id)
        ? "@" + agents.find((agent) => agent.id === id)!.name
        : id;
  const history = async (more = false) => {
    const own = ++historyRequest.current;
    try {
      const next = await fetch<History>(
        "/versions" +
          (more && versions.before ? `?before=${versions.before}` : ""),
      );
      if (alive.current && own === historyRequest.current)
        setVersions((previous) =>
          more
            ? { items: [...previous.items, ...next.items], before: next.before }
            : next,
        );
    } catch (error) {
      if (alive.current && own === historyRequest.current)
        setError((error as Error).message);
    }
  };
  const openItem = (value: Item) => {
    setItem(value);
    setText(value.text);
    setWhy(value.why || "");
    setEditing(false);
    setSheet("item");
    setVersions({ items: [], before: null });
    void history();
  };
  const showAll = async (kind: Item["kind"], more = false) => {
    const own = ++itemsRequest.current;
    setAllKind(kind);
    setSheet("all");
    if (!more) setAll(null);
    try {
      const next = await fetch<BriefItems>(
        `/items?kind=${kind}` +
          (more && all?.before
            ? `&before=${encodeURIComponent(all.before)}`
            : ""),
      );
      if (alive.current && own === itemsRequest.current)
        setAll((previous) =>
          more && previous
            ? {
                items: [...previous.items, ...next.items],
                before: next.before,
                sources: { ...previous.sources, ...next.sources },
                replacements: {
                  ...previous.replacements,
                  ...next.replacements,
                },
              }
            : next,
        );
    } catch (error) {
      if (alive.current && own === itemsRequest.current)
        setError((error as Error).message);
    }
  };
  const allSources = { ...page.sources, ...all?.sources };
  const navigate = (url: string) => {
    setSheet(null);
    onNavigate(url);
  };
  const versionsList = (
    <>
      <ol className="brief-history">
        {versions.items
          .filter(
            (version) =>
              sheet !== "item" ||
              version.changes.some((change) => change.id === item?.id),
          )
          .map((version) => (
            <li key={version.version}>
              <strong>Version {version.version}</strong> ·{" "}
              {new Date(version.at).toLocaleString()}
              <ul>
                {version.changes
                  .filter(
                    (change) => sheet !== "item" || change.id === item?.id,
                  )
                  .map((change) => (
                    <li key={change.field + change.id}>
                      {change.op} · {change.field.replaceAll("_", " ")}
                      {change.pinned ? " · pinned" : ""}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
      </ol>
      {versions.before && (
        <button
          type="button"
          className="text-button"
          onClick={() => void history(true)}
        >
          Older versions
        </button>
      )}
    </>
  );
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!page.settings.enabled && viewRecorded && (
        <p className="muted">
          Generation is off. These are your recorded items.
        </p>
      )}
      {page.settings.enabled || viewRecorded ? (
        <ProjectBriefView
          brief={page}
          workspace={workspace}
          author={author}
          onNavigate={navigate}
          onItem={openItem}
          onAll={(kind) => void showAll(kind)}
          onGoal={() => {
            setGoal(page.goal?.text || "");
            setSheet("goal");
          }}
          onSettings={() => setSheet("settings")}
          onHistory={() => {
            setSheet("history");
            setVersions({ items: [], before: null });
            void history();
          }}
          onDecision={() => {
            setText("");
            setWhy("");
            setEvidence("");
            setChoices([]);
            setSheet("decision");
            void fetch<{ items: BriefSource[] }>("/decision-sources")
              .then((result) => {
                if (alive.current) {
                  setChoices(result.items);
                  setEvidence(result.items[0]?.ref || "");
                }
              })
              .catch((error) => setError(error.message));
          }}
        />
      ) : (
        <section className="brief-setup">
          <h2>Your project, at a glance</h2>
          <BriefSettings
            page={page}
            connections={connections}
            busy={busy}
            save={({ lastError: _, ...settings }) =>
              void mutate("/settings", settings, "PUT")
            }
          />
          {(page.version > 0 || page.goal) && (
            <button
              type="button"
              className="text-button"
              onClick={() => setViewRecorded(true)}
            >
              View recorded brief
            </button>
          )}
        </section>
      )}
      {sheet && (
        <Sheet
          title={
            {
              goal: "Project goal",
              settings: "Brief settings",
              history: "Brief history",
              decision: "Record a decision",
              all: `All ${allKind === "question" ? "open questions" : allKind === "unfinished" ? "unfinished work" : allKind + "s"}`,
              item: "Brief item",
            }[sheet]
          }
          className="brief-sheet"
          swipeToClose
          onClose={() => setSheet(null)}
        >
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {sheet === "settings" && (
            <BriefSettings
              page={page}
              connections={connections}
              busy={busy}
              save={({ lastError: _, ...settings }) =>
                void mutate("/settings", settings, "PUT")
              }
            />
          )}
          {sheet === "goal" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void mutate("/goal", { text: goal.trim() || null }, "PUT");
              }}
            >
              <label>
                Goal · you
                <textarea
                  aria-label="Goal · you"
                  maxLength={200}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                />
              </label>
              <button className="primary" disabled={busy}>
                Save goal
              </button>
            </form>
          )}
          {sheet === "decision" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void mutate("/items", {
                  kind: "decision",
                  text,
                  why,
                  cite: [{ ref: evidence }],
                });
              }}
            >
              <label>
                Decision
                <textarea
                  aria-label="Decision"
                  required
                  maxLength={240}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <label>
                Why
                <textarea
                  aria-label="Why"
                  maxLength={240}
                  value={why}
                  onChange={(event) => setWhy(event.target.value)}
                />
              </label>
              <label>
                Evidence
                <select
                  aria-label="Evidence"
                  value={evidence}
                  onChange={(event) => setEvidence(event.target.value)}
                >
                  {choices.map((choice) => (
                    <option key={choice.ref} value={choice.ref}>
                      {choice.title} · {choice.excerpt.slice(0, 80)}
                    </option>
                  ))}
                </select>
              </label>
              {!choices.length && (
                <p>
                  Save a result or send a message in this project to record a
                  decision with evidence.
                </p>
              )}
              <button
                className="primary"
                disabled={busy || !text.trim() || !evidence}
              >
                Record decision
              </button>
            </form>
          )}
          {sheet === "history" && versionsList}
          {sheet === "all" &&
            (all ? (
              <>
                {all.items.map((value) => (
                  <ItemCard
                    key={value.id}
                    item={value}
                    sources={all.sources}
                    workspace={workspace}
                    onNavigate={navigate}
                    onItem={openItem}
                    author={author}
                    replacement={all.replacements[value.id]}
                    changed={page.changes.some(
                      (change) => change.id === value.id,
                    )}
                  />
                ))}
                {!all.items.length && <p>No items recorded.</p>}
                {all.before && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void showAll(allKind, true)}
                  >
                    Show more
                  </button>
                )}
              </>
            ) : (
              <p>Loading items…</p>
            ))}
          {sheet === "item" && item && (
            <>
              {editing ? (
                <form
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    void mutate(
                      `/items/${item.id}`,
                      { text, ...(item.kind === "decision" && { why }) },
                      "PATCH",
                    );
                  }}
                >
                  <label>
                    Text
                    <textarea
                      aria-label="Text"
                      required
                      maxLength={240}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                  </label>
                  {item.kind === "decision" && (
                    <label>
                      Why
                      <textarea
                        aria-label="Why"
                        maxLength={240}
                        value={why}
                        onChange={(event) => setWhy(event.target.value)}
                      />
                    </label>
                  )}
                  <p className="muted">
                    Editing pins your words. The item can still be resolved as
                    work progresses.
                  </p>
                  <button className="primary" disabled={busy || !text.trim()}>
                    Save edit
                  </button>
                </form>
              ) : (
                <>
                  <h3>{item.text}</h3>
                  {item.why && <p>{item.why}</p>}
                  {item.next && <p>Next · {item.next}</p>}
                  {item.blocker && <p>Blocked · {item.blocker}</p>}
                  {[
                    ...item.cite,
                    ...(item.answered_cite ? [item.answered_cite] : []),
                  ].map((cite, index) => {
                    const source = allSources[cite.ref],
                      href = source && briefSourceUrl(source, workspace);
                    return (
                      <div className="brief-source" key={cite.ref + index}>
                        <small>
                          {source?.title || "Source unavailable"}
                          {source?.at
                            ? " · " + new Date(source.at).toLocaleString()
                            : ""}
                        </small>
                        <blockquote>
                          {cite.quote ||
                            source?.excerpt ||
                            "The source is no longer available."}
                        </blockquote>
                        {href && (
                          <a
                            href={href}
                            onClick={(event) => {
                              event.preventDefault();
                              navigate(href);
                            }}
                          >
                            Open thread at result
                          </a>
                        )}
                      </div>
                    );
                  })}
                  <div className="brief-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          `/items/${item.id}`,
                          { pinned: !item.pinned },
                          "PATCH",
                        )
                      }
                    >
                      {item.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        busy || !["active", "open"].includes(item.status)
                      }
                      onClick={() =>
                        void mutate(
                          `/items/${item.id}`,
                          {
                            status: {
                              state: "retired",
                              decision: "superseded",
                              question: "answered",
                              unfinished: "done",
                            }[item.kind],
                          },
                          "PATCH",
                        )
                      }
                    >
                      {
                        {
                          state: "Retire",
                          decision: "Mark superseded",
                          question: "Mark answered",
                          unfinished: "Mark done",
                        }[item.kind]
                      }
                    </button>
                  </div>
                  <h4>Item history</h4>
                  {versionsList}
                </>
              )}
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
