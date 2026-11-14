import { useProjectionRoute } from "./SourceContext";
import { ProjectId, parseId } from "../shared/contract-ids.js";
import { literalEntry, proseEntry } from "./textEntry";
import { listenWorkspaceChanges } from "./workspace-changes";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlarmClock,
  ArrowUpRight,
  Check,
  Clock3,
  Search,
  Tag,
} from "lucide-react";
import { callRoute, readRoute } from "./api";
import { CollectionReadNotice, useCollectionRead } from "./CollectionRead";
import { workspaceApi, type RouteResponse } from "../shared/workspace-api";
import { executionSourceId } from "./sourceRouting";
import { useSourceId, useSourceRoute } from "./SourceContext";
import { useCards } from "./useCards";
import { ContentCard } from "./ContentCard";
import {
  resultAction,
  cardMessage,
  type ResultAction,
  type SavedMessage,
} from "./card-actions";
import type { CardEntry } from "../shared/cards";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import {
  LaterSheet,
  ScheduledSends,
  undoReminder,
  type ScheduledSend,
} from "./ThreadTools";
import { Avatar, RichText, Sheet } from "./components";
import { relativeTime, reminderReason } from "./threadView";
import { notify } from "./toast";

type LaterView = RouteResponse<typeof workspaceApi.laterList>["due"][number];
export type LaterSection = "all" | "saved" | "reminders" | "scheduled";

export type ShowLater = { section: LaterSection; focusId: string | null };
export const SHOW_LATER = "loop-show-later";
/**
 * Ask Later to open at a section, optionally highlighting one item. A page
 * that mounts reads the request from the view cache; one already open (your
 * profile, its Later list) hears it as an event.
 */
export function showLater(section: LaterSection, focusId?: string) {
  cacheView("later-section", section, viewOwner());
  cacheView("later-focus", focusId || null, viewOwner());
  const url = new URL(location.href);
  if (section !== "all") url.searchParams.set("profileTab", section);
  else url.searchParams.delete("profileTab");
  url.searchParams.delete("social");
  history.replaceState(history.state, "", url.pathname + url.search);
  window.dispatchEvent(
    new CustomEvent<ShowLater>(SHOW_LATER, {
      detail: { section, focusId: focusId || null },
    }),
  );
}

// Every Later item is a full-size card, matching result and Feed cards.
function Card({
  agentName,
  meta,
  eyebrow,
  title,
  content,
  onOpen,
  action,
  actions,
  due,
  focused,
  id,
}: {
  agentName: string | null;
  meta: string;
  eyebrow: ReactNode;
  title: string;
  content: string;
  onOpen: () => void;
  action?: ReactNode;
  actions?: ReactNode;
  due?: boolean;
  focused?: boolean;
  id?: string;
}) {
  return (
    <article
      id={id}
      tabIndex={-1}
      className={
        "feed-card later-card" +
        (due ? " due" : "") +
        (focused ? " focused" : "")
      }
    >
      <div className="card-byline">
        <span className="identity">
          <Avatar name={agentName || "Loop"} />
          <span>
            <strong>{agentName ? "@" + agentName : "Your workspace"}</strong>
            <span className="subline">{meta}</span>
          </span>
        </span>
        {action}
      </div>
      <div
        className="card-content"
        role="button"
        tabIndex={0}
        aria-label={"Open " + title}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("a,button,summary,input"))
            onOpen();
        }}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {content && (
          <div className="preview">
            <RichText content={content} compact />
          </div>
        )}
        <button className="text-button preview-open" onClick={onOpen}>
          Open <ArrowUpRight size={14} />
        </button>
      </div>
      {actions && <div className="card-actions">{actions}</div>}
    </article>
  );
}

/** Edit a saved item's short label ("Chosen approach"). Empty clears it. */
function LabelSheet({
  item,
  onClose,
  onSaved,
}: {
  item: { key: string; label: string | null };
  onClose: () => void;
  onSaved: (label: string | null) => void;
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
  const [label, setLabel] = useState(item.label || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title={item.label ? "Edit label" : "Add a label"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !current()) return;
          setBusy(true);
          setError("");
          try {
            const saved = await call(workspaceApi.savedLabel, {
              body: { key: item.key, label },
            });
            if (!current()) return;
            onSaved(saved.label);
            onClose();
          } catch (e) {
            if (current()) setError((e as Error).message);
          } finally {
            if (current()) setBusy(false);
          }
        }}
      >
        <label>
          Label
          <input
            {...proseEntry}
            value={label}
            maxLength={40}
            autoFocus
            placeholder="e.g. Chosen approach"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <p className="field-hint">
          A few words to recognise this later. Search in Saved finds labels too.
          Leave empty to remove it.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          Save label
        </button>
      </form>
    </Sheet>
  );
}

/**
 * Everything you keep, newest save first: full-size result and message
 * cards, a search over their text, thread titles and labels, and an optional
 * short label per item. Unsaving waits for its Undo to expire before it is
 * sent, so Undo keeps the item exactly where it was.
 */
type SavedListProps = {
  revision: number;
  project?: string;
  teams?: string;
  onOpen: (conversation: string, message?: string) => void;
  onReply: (message: SavedMessage) => void;
  renderResult: (
    item: ResultAction,
    options: { onUnsave: () => void },
  ) => ReactNode;
  searchLabel?: string;
};
export function SavedList(props: SavedListProps) {
  const source = useSourceId();
  return (
    <SavedCollection
      key={JSON.stringify([viewOwner(), source, props.project, props.teams])}
      {...props}
    />
  );
}
function SavedCollection({
  revision,
  project,
  teams,
  onOpen,
  onReply,
  renderResult,
  searchLabel = "Search Saved",
}: SavedListProps) {
  const readProjection = useProjectionRoute();

  const call = useSourceRoute();
  const source = useSourceId();
  const owner = viewOwner();
  const queryKey =
    "saved-query:" + JSON.stringify([owner, source, project, teams]);
  const [query, setQuery] = useState(() => cachedView<string>(queryKey) || "");
  const [filter, setFilter] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setFilter(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const {
    items,
    next,
    loading,
    busy,
    error: readError,
    load,
    retry,
    key,
  } = useCards(
    {
      view: "saved",
      project: parseId(ProjectId, project),
      teams,
      q: filter || undefined,
    },
    revision,
  );
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [labelling, setLabelling] = useState<CardEntry | null>(null);
  const alive = useRef(true);
  const pending = useRef(new Set<string>());
  const currentLoad = useRef(load);
  currentLoad.current = load;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setLabelling(null);
    setError("");
  }, [key]);
  useEffect(() => {
    setRemoving(
      (old) => new Set([...old].filter((id) => pending.current.has(id))),
    );
  }, [items]);
  function unsave(item: CardEntry) {
    const owner = viewOwner();
    pending.current.add(item.card.id);
    setRemoving((old) => new Set(old).add(item.card.id));
    const restore = () => {
      pending.current.delete(item.card.id);
      if (alive.current && viewOwner() === owner)
        setRemoving((old) => {
          const next = new Set(old);
          next.delete(item.card.id);
          return next;
        });
    };
    notify({
      text: "Removed from Saved.",
      undo: restore,
      onExpire: () => {
        // The originating source stays captured even if Undo outlives navigation.
        void (async () => {
          if (viewOwner() !== owner) return;
          if (item.card.type === "message") {
            const messageId = item.card.source.message_id;
            if (!messageId) throw new Error("Saved message is unavailable.");
            await call(workspaceApi.messageUnsave, {
              params: { id: messageId },
              body: undefined,
            });
          } else {
            const artifactId = item.card.source.artifact_id;
            if (!artifactId) throw new Error("Saved result is unavailable.");
            const current = await readProjection(
              workspaceApi.artifactDetail,
              {
                params: { id: artifactId },
              },
              { mode: "manual" },
            );
            if (viewOwner() !== owner) return;
            await call(workspaceApi.artifactUpdate, {
              params: { id: current.id },
              body: { pinned: false, version: current.version },
            });
          }
          pending.current.delete(item.card.id);
          if (alive.current) await currentLoad.current();
          window.dispatchEvent(new Event("loop-later-change"));
        })().catch((e) => {
          restore();
          if (alive.current && viewOwner() === owner) setError(e.message);
        });
      },
    });
  }
  const visible = items.filter((item) => !removing.has(item.card.id));
  return (
    <>
      <form
        className="search-box saved-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <Search size={18} aria-hidden="true" />
        <input
          {...literalEntry}
          type="search"
          enterKeyHint="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            cacheView(queryKey, e.target.value, owner);
          }}
        />
      </form>
      <CollectionReadNotice
        error={readError}
        busy={busy}
        retry={() => void retry()}
      />
      {error && (
        <div className="error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError("");
              void load();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {visible.length ? (
        <div className="feed saved-feed">
          {visible.map((item) => (
            <div className="saved-item" key={item.card.id}>
              <div className="saved-label-row">
                <Tag size={14} aria-hidden="true" />
                {item.saved?.label && (
                  <span className="saved-label">{item.saved.label}</span>
                )}
                <button
                  className="text-button"
                  aria-label={
                    item.saved?.label
                      ? `Edit label ${item.saved.label}`
                      : "Add a label"
                  }
                  onClick={() => setLabelling(item)}
                >
                  {item.saved?.label ? "Edit" : "Add label"}
                </button>
                <span className="saved-when">
                  Saved {relativeTime(item.saved!.at).toLowerCase()}
                </span>
              </div>
              {item.card.type === "result" ? (
                renderResult(resultAction(item.card, source), {
                  onUnsave: () => unsave(item),
                })
              ) : (
                <ContentCard
                  card={item.card}
                  onOpen={() =>
                    onOpen(
                      item.card.source.conversation_id!,
                      item.card.source.message_id!,
                    )
                  }
                  onReply={() => {
                    if (item.card.type === "message")
                      onReply(cardMessage(item.card));
                  }}
                  onSave={() => unsave(item)}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="section-empty">
          {loading
            ? "Loading…"
            : filter
              ? `Nothing saved matches “${filter}”.`
              : "Tap Save on any result or message to keep it here."}
        </p>
      )}
      {next && (
        <button
          className="secondary load-more"
          disabled={loading}
          onClick={() => void load(true)}
        >
          More saved
        </button>
      )}
      {labelling && (
        <LabelSheet
          key={key + labelling.card.id}
          item={{
            key: labelling.card.id,
            label: labelling.saved?.label || null,
          }}
          onClose={() => setLabelling(null)}
          onSaved={(label) => {
            void load();
            notify({ text: label ? `Labelled “${label}”.` : "Label removed." });
          }}
        />
      )}
    </>
  );
}

export function Later({
  revision,
  onOpen,
  onArtifact,
  onReply,
  onDraft,
  renderResult,
  project,
  teams,
  only,
}: {
  revision: number;
  /** Show just this section, chosen by the page around it (no chip row). */
  only?: Exclude<LaterSection, "all">;
  /** The same project and team scope as the results feed. */
  project?: string;
  teams?: string;
  onOpen: (conversation: string, message?: string) => void;
  onArtifact: (id: string) => void;
  onReply: (message: SavedMessage) => void;
  /** Put a message that could not be sent back into a draft. */
  onDraft: (item: ScheduledSend) => void;
  renderResult: (
    item: ResultAction,
    options: { onUnsave: () => void },
  ) => ReactNode;
}) {
  const sourceId = useSourceId();
  const recovery = useCollectionRead(JSON.stringify([sourceId, only]));
  const read = recovery.load;
  type Reminders = RouteResponse<typeof workspaceApi.laterList>;
  const cacheKey = "later:reminders:" + sourceId;
  const shown = cachedView<Reminders>(cacheKey);
  const [later, setLater] = useState<Reminders | null>(shown || null);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState("");
  const [snoozing, setSnoozing] = useState<LaterView | null>(null);
  const [section, setSectionState] = useState<LaterSection>(() => {
    return cachedView<LaterSection>("later-section") || "all";
  });
  const [focus, setFocus] = useState<string | null>(
    () =>
      new URLSearchParams(location.search).get("scheduledSend") ||
      cachedView<string | null>("later-focus") ||
      null,
  );
  useEffect(() => cacheView("later-focus", null, viewOwner()), []);
  useEffect(() => {
    const shown = (event: Event) => {
      const { section, focusId } = (event as CustomEvent<ShowLater>).detail;
      // A list for another section is about to be replaced; the one that
      // mounts reads the focus from the cache.
      if (only && only !== section) return;
      setSectionState(section);
      setFocus(focusId);
      cacheView("later-focus", null, viewOwner());
    };
    window.addEventListener(SHOW_LATER, shown);
    return () => window.removeEventListener(SHOW_LATER, shown);
  }, [only]);
  const setSection = (value: LaterSection) => {
    setSectionState(value);
    setFocus(null);
    cacheView("later-section", value, viewOwner());
  };
  async function load(manual = false) {
    // The selected section owns its reader. Scheduled/Saved render their own
    // collections; their hidden reminder/count reader must not fail beside it.
    if (only && only !== "reminders") return;
    // The account this request is for; a late answer for another is dropped.
    const owner = viewOwner();
    await read(
      (signal, mode) =>
        Promise.all([
          readRoute(
            workspaceApi.laterList,
            {},
            sourceId,
            signal,
            undefined,
            mode,
          ),
          only
            ? Promise.resolve({ items: [] })
            : readRoute(
                workspaceApi.scheduledSendList,
                {},
                sourceId,
                signal,
                undefined,
                mode,
              ),
        ]),
      ([items, scheduled]) => {
        setLater(items);
        setFailed(scheduled.items.filter((i) => i.state === "failed").length);
        cacheView(cacheKey, items, owner);
      },
      manual,
    );
  }
  useEffect(() => {
    setLater(cachedView<Reminders>(cacheKey) || null);
    setFailed(0);
  }, [read]);
  useEffect(() => {
    void load();
    const update = () => void load();
    window.addEventListener("loop-later-change", update);
    window.addEventListener("loop-scheduled-change", update);
    const stopChanges = listenWorkspaceChanges("later", update, sourceId);
    const stopScheduled = listenWorkspaceChanges("scheduled", update, sourceId);
    return () => {
      window.removeEventListener("loop-later-change", update);
      window.removeEventListener("loop-scheduled-change", update);
      stopChanges();
      stopScheduled();
    };
  }, [sourceId, read]);
  useEffect(() => {
    if (!focus || !later) return;
    const node = document.getElementById("later-" + focus);
    node?.scrollIntoView({ block: "center" });
    node?.focus({ preventScroll: true });
  }, [focus, !!later]);
  function open(item: LaterView) {
    if (item.kind === "artifact") onArtifact(item.target_id);
    // A saved story is on someone else's site, so it opens there.
    else if (item.kind === "story" && item.url)
      window.open(item.url, "_blank", "noopener,noreferrer");
    else if (item.conversation_id)
      onOpen(item.conversation_id, item.message_id || undefined);
  }
  async function done(item: LaterView, due: boolean) {
    try {
      await callRoute(
        workspaceApi.laterFinish,
        { params: { id: item.id }, body: undefined },
        executionSourceId(),
      );
      window.dispatchEvent(new Event("loop-later-change"));
      // Undo reopens this same reminder: Done is a state, not a deletion.
      notify({
        text: due ? "Marked done." : "Reminder cancelled.",
        undo: async () => {
          await callRoute(
            workspaceApi.laterReopen,
            { params: { id: item.id }, body: {} },
            executionSourceId(),
          );
          window.dispatchEvent(new Event("loop-later-change"));
        },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const reminderCard = (item: LaterView, due: boolean) => {
    const reason = reminderReason(item);
    return (
      <Card
        key={item.id}
        id={"later-" + item.id}
        focused={focus === item.id}
        agentName={item.agent_name}
        meta={
          due
            ? `Back ${relativeTime(item.surfaced_at || item.created_at).toLowerCase()}`
            : reason
        }
        eyebrow={
          <>
            {due ? <AlarmClock size={13} /> : <Clock3 size={13} />}{" "}
            {due ? reason || "Back now" : "Reminder"}
            {!!item.snoozes && <span> · snoozed {item.snoozes}×</span>}
            {item.project_name && (
              <span className="card-project"> · {item.project_name}</span>
            )}
          </>
        }
        title={item.title}
        content={item.content || item.preview}
        onOpen={() => open(item)}
        due={due}
        actions={
          <>
            <button
              type="button"
              aria-label={
                due
                  ? `Done with ${item.title}`
                  : `Cancel reminder for ${item.title}`
              }
              onClick={() => void done(item, due)}
            >
              <Check size={16} /> {due ? "Done" : "Cancel"}
            </button>
            <button
              type="button"
              aria-label={`${due ? "Snooze again" : "Change"} reminder for ${item.title}`}
              onClick={() => setSnoozing(item)}
            >
              <AlarmClock size={16} /> {due ? "Snooze again" : "Change"}
            </button>
          </>
        }
      />
    );
  };
  const visible = only || section;
  const show = (value: LaterSection) => visible === "all" || visible === value;
  const counts: Partial<Record<LaterSection, number>> = {
    reminders: later?.due.length || 0,
    scheduled: failed,
  };
  return (
    <section className="later-page" aria-label="Later">
      {!only && (
        <div
          className="chip-row later-sections"
          role="tablist"
          aria-label="Show"
        >
          {(
            [
              ["saved", "Saved"],
              ["reminders", "Reminders"],
              ["scheduled", "Scheduled"],
              ["all", "Everything"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              type="button"
              className={
                "chip" + (value === "scheduled" && failed ? " attention" : "")
              }
              aria-selected={section === value}
              onClick={() => setSection(value)}
            >
              {label}
              {!!counts[value] && (
                <span
                  className="chip-count"
                  aria-label={
                    value === "scheduled"
                      ? `${counts[value]} not sent`
                      : `${counts[value]} back now`
                  }
                >
                  {counts[value]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <CollectionReadNotice {...recovery} retry={() => void load(true)} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {show("reminders") && (
        <>
          {!only && <h2 className="section-title">Reminders</h2>}
          <p className="section-hint">
            Items brought back to you. Nothing is sent to an agent.
          </p>
          {!!later?.due.length && (
            <>
              <h3 className="section-subtitle">Back now</h3>
              <div className="feed">
                {later.due.map((i) => reminderCard(i, true))}
              </div>
            </>
          )}
          {later?.upcoming.length ? (
            <>
              <h3 className="section-subtitle">Upcoming</h3>
              <div className="feed">
                {later.upcoming.map((i) => reminderCard(i, false))}
              </div>
            </>
          ) : (
            !later?.due.length && (
              <p className="section-empty">
                {later
                  ? "Use “Remind me” on a thread, result or message."
                  : "Loading…"}
              </p>
            )
          )}
        </>
      )}
      {show("scheduled") && (
        <>
          {!only && <h2 className="section-title">Scheduled</h2>}
          <p className="section-hint">
            Messages you asked Loop to send to an agent later.
          </p>
          <ScheduledSends
            revision={revision}
            focusId={focus}
            onOpen={(c) => onOpen(c)}
            onDraft={onDraft}
          />
        </>
      )}
      {show("saved") && (
        <>
          {!only && <h2 className="section-title">Saved</h2>}
          <SavedList
            revision={revision}
            project={project}
            teams={teams}
            onOpen={onOpen}
            onReply={onReply}
            renderResult={renderResult}
          />
        </>
      )}
      {snoozing && (
        <LaterSheet
          kind={snoozing.kind}
          targetId={snoozing.target_id}
          itemId={snoozing.id}
          title={snoozing.title}
          onClose={() => setSnoozing(null)}
          onDone={(label) =>
            notify({ text: `Snoozed again: ${label.toLowerCase()}.` })
          }
        />
      )}
    </section>
  );
}

export { undoReminder };
