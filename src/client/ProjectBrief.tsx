import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Pencil, Pin, PinOff } from "lucide-react";
import "./projectBrief.css";
import { apiInWorkspace } from "./api";
import {
  canGenerateBrief,
  canSelectBriefModel,
} from "../shared/brief-connections";
import { executionSourceId } from "./sourceRouting";
import { viewOwner } from "./viewCache";
import { Sheet } from "./components";
import { ConnectionDetails } from "./ConnectionDetails";
import { ConnectionPicker, ModelPicker } from "./ConnectionPicker";
import { modelGroups } from "./modelChoices";
import { BriefAcknowledgements, briefSourceUrl } from "./briefView";
import {
  ProjectBriefView,
  BriefItemCard,
  BriefTabs,
  type BriefSection,
} from "./ProjectBriefView";
import {
  BriefEvidence,
  BriefHistoryList,
  BriefItemSummary,
  briefItemLabels,
  briefLifecycle,
  itemCitations,
  type BriefHistory,
} from "./BriefItemContent";
import type { Agent, Connection } from "../shared/types";
import type {
  BriefItems,
  BriefPage,
  BriefSource,
  Item,
} from "../shared/briefs";
export { ProjectBriefView } from "./ProjectBriefView";

type Props = {
  projectId: string;
  initial: BriefPage;
  acknowledgements: BriefAcknowledgements;
  connections: Connection[];
  agents: Agent[];
  onNavigate: (url: string) => void;
  onChanged: (brief: BriefPage) => void;
};
type SheetKind = "goal" | "settings" | "history" | "decision" | "all" | "item";
type Selection = {
  item: Item;
  sources: Record<string, BriefSource>;
  fromLedger: boolean;
  replacement?: string;
};

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

export function ProjectBrief(props: Props) {
  const workspace = executionSourceId(),
    owner = viewOwner();
  return (
    <ProjectBriefSession
      key={JSON.stringify([owner, workspace, props.projectId])}
      {...props}
      workspace={workspace}
      owner={owner}
    />
  );
}

function ProjectBriefSession({
  projectId,
  initial,
  acknowledgements,
  connections,
  agents,
  onNavigate,
  onChanged,
  workspace,
  owner,
}: Props & { workspace: string; owner: string | undefined }) {
  const [page, setPage] = useState(initial),
    [loadError, setLoadError] = useState(""),
    [ackError, setAckError] = useState(""),
    [actionError, setActionError] = useState(""),
    [busy, setBusy] = useState(false),
    [viewRecorded, setViewRecorded] = useState(false);
  const [sheet, setSheet] = useState<SheetKind | null>(null),
    [section, setSection] = useState<BriefSection>("state"),
    [selection, setSelection] = useState<Selection | null>(null),
    [editing, setEditing] = useState(false),
    [detailTab, setDetailTab] = useState<"evidence" | "history">("evidence"),
    [sourceRef, setSourceRef] = useState("");
  const [goal, setGoal] = useState(""),
    [text, setText] = useState(""),
    [why, setWhy] = useState(""),
    [evidence, setEvidence] = useState("");
  const [choices, setChoices] = useState<BriefSource[]>([]),
    [choicesPending, setChoicesPending] = useState(false),
    [choicesError, setChoicesError] = useState("");
  const [all, setAll] = useState<BriefItems | null>(null),
    [allKind, setAllKind] = useState<Item["kind"]>("decision"),
    [allPending, setAllPending] = useState(false),
    [allError, setAllError] = useState("");
  const [versions, setVersions] = useState<BriefHistory | null>(null),
    [historyPending, setHistoryPending] = useState(false),
    [historyError, setHistoryError] = useState("");
  const root = `/projects/${encodeURIComponent(projectId)}/brief`,
    formId = useId();
  const request = useRef(0),
    itemsRequest = useRef(0),
    historyRequest = useRef(0),
    choicesRequest = useRef(0),
    ackRequest = useRef(0),
    sheetEpoch = useRef(0),
    locked = useRef(false),
    alive = useRef(true),
    itemsLoading = useRef(false),
    historyLoading = useRef(false),
    choicesLoading = useRef(false);
  const valid = () =>
    alive.current && owner === viewOwner() && workspace === executionSourceId();
  const fetch = <T,>(path = "", body?: unknown, method?: string) =>
    apiInWorkspace<T>(root + path, workspace, body, method);
  const load = async () => {
    if (locked.current || !valid()) return;
    const own = ++request.current;
    try {
      const next = await fetch<BriefPage>();
      if (valid() && own === request.current) {
        setPage(next);
        setSelection((current) => {
          if (!current) return current;
          const sources: Record<string, BriefSource> = current.fromLedger
            ? { ...current.sources }
            : {};
          // Compact evidence follows the refreshed page even when an item
          // leaves it. Preserve separately loaded ledger-only evidence.
          for (const cite of [
            ...(next.headline?.cite ?? []),
            ...[
              ...next.state,
              ...next.decisions,
              ...next.open_questions,
              ...next.unfinished,
            ].flatMap(itemCitations),
          ]) {
            if (next.sources[cite.ref]) sources[cite.ref] = next.sources[cite.ref];
            else delete sources[cite.ref];
          }
          return { ...current, sources };
        });
        setLoadError("");
        onChanged(next);
      }
    } catch (error) {
      if (valid() && own === request.current)
        setLoadError((error as Error).message);
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
  }, []);
  useEffect(() => {
    if (!valid() || (!page.settings.enabled && !viewRecorded)) return;
    const own = ++ackRequest.current;
    void acknowledgements
      .acknowledge(page.version, page.acknowledged_version, (version) =>
        fetch("/ack", { version }),
      )
      .then(() => {
        if (valid() && own === ackRequest.current) setAckError("");
      })
      .catch((error) => {
        if (valid() && own === ackRequest.current) setAckError(error.message);
      });
  }, [page, viewRecorded]);
  const invalidateDetails = () => {
    itemsRequest.current++;
    historyRequest.current++;
    choicesRequest.current++;
    itemsLoading.current =
      historyLoading.current =
      choicesLoading.current =
        false;
    setAllPending(false);
    setHistoryPending(false);
    setChoicesPending(false);
  };
  const close = () => {
    sheetEpoch.current++;
    invalidateDetails();
    setSheet(null);
  };
  const open = (kind: SheetKind) => {
    if (locked.current || !valid()) return false;
    sheetEpoch.current++;
    invalidateDetails();
    setActionError("");
    setAllError("");
    setHistoryError("");
    setChoicesError("");
    setSheet(kind);
    if (kind !== "all") setAll(null);
    return true;
  };
  const mutate = async (path: string, body: unknown, method = "POST") => {
    if (locked.current || !valid()) return;
    locked.current = true;
    const epoch = sheetEpoch.current;
    request.current++;
    invalidateDetails();
    setBusy(true);
    setActionError("");
    try {
      const next = await fetch<BriefPage>(path, body, method);
      if (valid()) {
        setPage(next);
        setLoadError("");
        onChanged(next);
        if (path === "/items" && method === "POST") setSection("decisions");
        if (path === "/settings" && !next.settings.enabled)
          setViewRecorded(false);
        if (epoch === sheetEpoch.current) close();
        setAll(null);
      }
    } catch (error) {
      if (valid()) setActionError((error as Error).message);
    } finally {
      locked.current = false;
      if (valid()) setBusy(false);
    }
  };
  const author = (id: string) =>
    id === "you"
      ? "you"
      : agents.find((agent) => agent.id === id)
        ? "@" + agents.find((agent) => agent.id === id)!.name
        : id;
  const history = async (more = false) => {
    if (
      !valid() ||
      historyLoading.current ||
      (more && versions?.before == null)
    )
      return;
    historyLoading.current = true;
    const own = ++historyRequest.current;
    setHistoryPending(true);
    setHistoryError("");
    try {
      const next = await fetch<BriefHistory>(
        "/versions" + (more ? `?before=${versions!.before}` : ""),
      );
      if (valid() && own === historyRequest.current)
        setVersions((previous) =>
          more && previous
            ? {
                items: [
                  ...previous.items,
                  ...next.items.filter(
                    (v) => !previous.items.some((p) => p.version === v.version),
                  ),
                ],
                before: next.before,
              }
            : next,
        );
    } catch (error) {
      if (valid() && own === historyRequest.current)
        setHistoryError((error as Error).message);
    } finally {
      if (own === historyRequest.current) {
        historyLoading.current = false;
        if (valid()) setHistoryPending(false);
      }
    }
  };
  const openItem = (item: Item, ledger?: BriefItems) => {
    if (!open("item")) return;
    const sources = { ...page.sources, ...ledger?.sources };
    setSelection({
      item,
      sources,
      fromLedger: !!ledger,
      replacement: ledger?.replacements[item.id],
    });
    setSourceRef("");
    setText(item.text);
    setWhy(item.why || "");
    setEditing(false);
    setDetailTab("evidence");
    setVersions(null);
    void history();
  };
  const showAll = async (kind: Item["kind"], more = false) => {
    if (!valid()) return;
    if (more) {
      if (itemsLoading.current || !all?.before) return;
    } else {
      if (!open("all")) return;
      setAll(null);
      setAllKind(kind);
    }
    itemsLoading.current = true;
    const own = ++itemsRequest.current;
    setAllPending(true);
    setAllError("");
    try {
      const next = await fetch<BriefItems>(
        `/items?kind=${kind}` +
          (more ? `&before=${encodeURIComponent(all!.before!)}` : ""),
      );
      if (valid() && own === itemsRequest.current)
        setAll((previous) =>
          more && previous
            ? {
                items: [
                  ...previous.items,
                  ...next.items.filter(
                    (item) => !previous.items.some((p) => p.id === item.id),
                  ),
                ],
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
      if (valid() && own === itemsRequest.current)
        setAllError((error as Error).message);
    } finally {
      if (own === itemsRequest.current) {
        itemsLoading.current = false;
        if (valid()) setAllPending(false);
      }
    }
  };
  const decisionSources = async () => {
    if (!valid() || choicesLoading.current) return;
    choicesLoading.current = true;
    const own = ++choicesRequest.current;
    setChoicesPending(true);
    setChoicesError("");
    try {
      const next = await fetch<{ items: BriefSource[] }>("/decision-sources");
      if (valid() && own === choicesRequest.current) {
        setChoices(next.items);
        setEvidence((previous) =>
          next.items.some((source) => source.ref === previous)
            ? previous
            : next.items[0]?.ref || "",
        );
      }
    } catch (error) {
      if (valid() && own === choicesRequest.current)
        setChoicesError((error as Error).message);
    } finally {
      if (own === choicesRequest.current) {
        choicesLoading.current = false;
        if (valid()) setChoicesPending(false);
      }
    }
  };
  const navigate = (url: string) => {
    close();
    onNavigate(url);
  };
  const saveSettings = ({ lastError: _, ...settings }: BriefPage["settings"]) =>
    void mutate("/settings", settings, "PUT");
  const item = selection?.item;
  const sources = selection?.sources ?? {};
  const sourceChoices = item
    ? [...new Set(itemCitations(item).map((cite) => cite.ref))]
        .map((ref) => sources[ref])
        .filter((source) => source && briefSourceUrl(source, workspace))
    : [];
  const chosenSource = sourceChoices.length === 1
    ? sourceChoices[0]
    : sourceChoices.find((source) => source.ref === sourceRef);
  const sourceUrl = chosenSource && briefSourceUrl(chosenSource, workspace);
  const itemPath = item ? `/items/${encodeURIComponent(item.id)}` : "";
  const historyList = (
    <BriefHistoryList
      history={versions}
      pending={historyPending}
      error={historyError}
      itemId={sheet === "item" ? item?.id : undefined}
      onRetry={() => void history(versions?.before != null)}
      onMore={() => void history(true)}
    />
  );
  const footer =
    sheet === "goal" ||
    sheet === "decision" ||
    (sheet === "item" && editing) ? (
      <div className="brief-form-actions" key="form-actions">
        {editing && sheet === "item" && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            Cancel edit
          </button>
        )}
        <button
          className="primary"
          form={formId}
          type="submit"
          disabled={
            busy ||
            (sheet !== "goal" && !text.trim()) ||
            (sheet === "decision" &&
              (!evidence || choicesPending || !!choicesError))
          }
        >
          {busy
            ? "Saving…"
            : sheet === "goal"
              ? "Save goal"
              : sheet === "decision"
                ? "Record decision"
                : "Save edit"}
        </button>
      </div>
    ) : sheet === "item" && item ? (
      <>
        {sourceChoices.length > 1 && (
          <label className="brief-source-picker">
            Source to open
            <select
              aria-label="Source to open"
              value={sourceRef}
              onChange={(event) => setSourceRef(event.target.value)}
              disabled={busy}
            >
              <option value="">Choose a source</option>
              {sourceChoices.map((source) => (
                <option key={source.ref} value={source.ref}>
                  {source.title} · {source.excerpt.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="brief-item-footer" key="item-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !sourceUrl}
            onClick={() => {
              if (sourceUrl) navigate(sourceUrl);
            }}
          >
            {sourceChoices.length ? "Open source" : "Source unavailable"}
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="secondary"
            aria-label={item.pinned ? "Unpin" : "Pin"}
            title={item.pinned ? "Unpin wording" : "Pin wording"}
            disabled={busy}
            onClick={() =>
              void mutate(itemPath, { pinned: !item.pinned }, "PATCH")
            }
          >
            {item.pinned ? (
              <PinOff size={18} aria-hidden="true" />
            ) : (
              <Pin size={18} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="secondary"
            aria-label="Edit"
            title="Edit item"
            disabled={busy}
            onClick={() => {
              setActionError("");
              setText(item.text);
              setWhy(item.why || "");
              setEditing(true);
            }}
          >
            <Pencil size={18} aria-hidden="true" />
          </button>
        </div>
      </>
    ) : undefined;
  return (
    <>
      {(loadError || ackError) && (
        <div className="brief-notice error" role="alert">
          <p>{loadError || ackError}</p>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void load()}
          >
            Retry brief
          </button>
        </div>
      )}
      {actionError && !sheet && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {busy && (
        <p className="muted" role="status">
          Saving your change…
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
          section={section}
          onSectionChange={setSection}
          workspace={workspace}
          author={author}
          onNavigate={navigate}
          onItem={openItem}
          onAll={(kind) => void showAll(kind)}
          onGoal={() => {
            if (open("goal")) setGoal(page.goal?.text || "");
          }}
          onSettings={() => open("settings")}
          onHistory={() => {
            if (open("history")) {
              setVersions(null);
              void history();
            }
          }}
          onDecision={() => {
            if (open("decision")) {
              setText("");
              setWhy("");
              setEvidence("");
              setChoices([]);
              void decisionSources();
            }
          }}
        />
      ) : (
        <section className="brief-setup">
          <h2>Your project, at a glance</h2>
          <BriefSettings
            page={page}
            connections={connections}
            busy={busy}
            save={saveSettings}
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
            sheet === "item" && item
              ? briefItemLabels[item.kind]
              : {
                  goal: "Project goal",
                  settings: "Brief settings",
                  history: "Brief history",
                  decision: "Record a decision",
                  all: `All ${allKind === "question" ? "questions" : allKind === "unfinished" ? "unfinished work" : allKind === "state" ? "state" : "decisions"}`,
                  item: "Brief item",
                }[sheet]
          }
          className={
            "brief-sheet" + (sheet === "item" ? " brief-detail-sheet" : "")
          }
          swipeToClose
          onClose={close}
          footer={footer}
        >
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
          {sheet === "settings" && (
            <BriefSettings
              page={page}
              connections={connections}
              busy={busy}
              save={saveSettings}
            />
          )}
          {sheet === "goal" && (
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void mutate("/goal", { text: goal.trim() || null }, "PUT");
              }}
            >
              <p className="muted">
                Set the direction for this project. Only you control the goal.
              </p>
              <label>
                Goal · you
                <textarea
                  aria-label="Goal · you"
                  maxLength={200}
                  value={goal}
                  disabled={busy}
                  onChange={(event) => setGoal(event.target.value)}
                />
              </label>
            </form>
          )}
          {sheet === "decision" && (
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                if (evidence && !choicesPending && !choicesError)
                  void mutate("/items", {
                    kind: "decision",
                    text: text.trim(),
                    why: why.trim(),
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
                  disabled={busy}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <label>
                Why
                <textarea
                  aria-label="Why"
                  maxLength={240}
                  value={why}
                  disabled={busy}
                  onChange={(event) => setWhy(event.target.value)}
                />
              </label>
              {choicesPending && (
                <p className="muted" role="status">
                  Loading evidence…
                </p>
              )}
              {choicesError && (
                <div className="brief-notice error" role="alert">
                  <p>{choicesError}</p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || choicesPending}
                    onClick={() => void decisionSources()}
                  >
                    Retry evidence
                  </button>
                </div>
              )}
              {!!choices.length && (
                <label>
                  Evidence
                  <select
                    aria-label="Evidence"
                    value={evidence}
                    disabled={busy || choicesPending}
                    onChange={(event) => setEvidence(event.target.value)}
                  >
                    {choices.map((choice) => (
                      <option key={choice.ref} value={choice.ref}>
                        {choice.title} · {choice.excerpt.slice(0, 80)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!choices.length && !choicesPending && !choicesError && (
                <p className="brief-empty">
                  Save a result or send a message in this project to record a
                  decision with evidence.
                </p>
              )}
            </form>
          )}
          {sheet === "history" && historyList}
          {sheet === "all" && (
            <div aria-busy={allPending}>
              {allPending && (
                <p className="muted" role="status">
                  Loading items…
                </p>
              )}
              {allError && (
                <div className="brief-notice error" role="alert">
                  <p>{allError}</p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={allPending}
                    onClick={() => void showAll(allKind, !!all?.before)}
                  >
                    Retry items
                  </button>
                </div>
              )}
              {all?.items.map((value) => (
                <BriefItemCard
                  key={value.id}
                  item={value}
                  sources={all.sources}
                  workspace={workspace}
                  onNavigate={navigate}
                  onItem={(value) => openItem(value, all)}
                  author={author}
                  replacement={all.replacements[value.id]}
                  changed={page.changes.some(
                    (change) => change.id === value.id,
                  )}
                />
              ))}
              {all && !all.items.length && !allPending && (
                <p className="brief-empty">No items recorded.</p>
              )}
              {all?.before && (
                <button
                  type="button"
                  className="text-button brief-all"
                  disabled={allPending}
                  onClick={() => void showAll(allKind, true)}
                >
                  Show more
                </button>
              )}
            </div>
          )}
          {sheet === "item" &&
            item &&
            (editing ? (
              <form
                id={formId}
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(
                    itemPath,
                    {
                      text: text.trim(),
                      ...(item.kind === "decision" && { why: why.trim() }),
                    },
                    "PATCH",
                  );
                }}
              >
                <label>
                  Text
                  <textarea
                    aria-label="Text"
                    autoFocus
                    required
                    maxLength={240}
                    value={text}
                    disabled={busy}
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
                      disabled={busy}
                      onChange={(event) => setWhy(event.target.value)}
                    />
                  </label>
                )}
                <p className="muted">
                  Editing pins your words. The item can still be resolved as
                  work progresses.
                </p>
              </form>
            ) : (
              <>
                <BriefItemSummary
                  item={item}
                  author={author}
                  replacement={selection?.replacement}
                />
                <BriefTabs
                  label="Item details"
                  value={detailTab}
                  options={[
                    {
                      value: "evidence",
                      label: "Evidence",
                      count: itemCitations(item).length,
                    },
                    { value: "history", label: "History" },
                  ]}
                  onChange={setDetailTab}
                >
                  {detailTab === "evidence" ? (
                    <BriefEvidence
                      item={item}
                      sources={sources}
                      workspace={workspace}
                      onNavigate={navigate}
                    />
                  ) : (
                    historyList
                  )}
                </BriefTabs>
                <details className="brief-lifecycle">
                  <summary>More actions</summary>
                  <p className="muted">
                    {item.pinned
                      ? "Pinning preserves the wording; this item can still be resolved."
                      : "Update this item’s place in the project record."}
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !["active", "open"].includes(item.status)}
                    onClick={() =>
                      void mutate(
                        itemPath,
                        { status: briefLifecycle[item.kind].status },
                        "PATCH",
                      )
                    }
                  >
                    {briefLifecycle[item.kind].label}
                  </button>
                </details>
              </>
            ))}
        </Sheet>
      )}
    </>
  );
}
