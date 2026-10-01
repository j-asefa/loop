import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlarmClock,
  ArrowUpRight,
  Bookmark,
  Check,
  Clock3,
  MessageSquare,
  Search,
  Tag,
} from "lucide-react";
import { api } from "./api";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import {
  LaterSheet,
  ScheduledSends,
  undoReminder,
  type ScheduledSend,
} from "./ThreadTools";
import type { Artifact } from "../shared/types";
import { Avatar, RichText, Sheet } from "./components";
import { dayLabel, relativeTime, reminderReason, timeLabel } from "./threadView";
import { notify } from "./toast";

type LaterView = {
  id: string;
  kind: "conversation" | "artifact" | "message";
  target_id: string;
  condition: "time" | "run_finished" | "project_open";
  due_at: number | null;
  surfaced_at: number | null;
  created_at: number;
  snoozes?: number;
  title: string;
  preview: string;
  content?: string;
  provider: string | null;
  conversation_id: string | null;
  message_id: string | null;
  agent_name: string | null;
  project_name: string | null;
};
export type SavedMessage = {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  role: string;
  preview: string;
  content?: string;
  created_at: number;
  agent_id: string | null;
  agent_name: string | null;
  provider: string | null;
  project_name: string | null;
};
// Results and messages share one Saved list, newest save first.
type SavedItem = { key: string; saved_at: number; label?: string | null } & (
  | { kind: "message"; message: SavedMessage }
  | { kind: "result"; result: Artifact }
);
type SavedPage = { items: SavedItem[]; next: string | null };
export type LaterSection = "all" | "saved" | "reminders" | "scheduled";

/** Ask Later to open at a section, optionally highlighting one item. */
export function showLater(section: LaterSection, focusId?: string) {
  cacheView("later-section", section, viewOwner());
  cacheView("later-focus", focusId || null, viewOwner());
}

// Every Later item is a full-size card, matching result and inbox cards.
function Card({
  agentName,
  provider,
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
  provider: string | null;
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
        "feed-card later-card" + (due ? " due" : "") + (focused ? " focused" : "")
      }
    >
      <div className="card-byline">
        <span className="identity">
          <Avatar name={agentName || "Loop"} provider={provider as any} />
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
  item: SavedItem;
  onClose: () => void;
  onSaved: (label: string | null) => void;
}) {
  const [label, setLabel] = useState(item.label || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title={item.label ? "Edit label" : "Add a label"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const saved = await api<{ label: string | null }>(
              "/saved/label",
              { key: item.key, label },
              "PUT",
            );
            onSaved(saved.label);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Label
          <input
            value={label}
            maxLength={40}
            autoFocus
            placeholder="e.g. Chosen approach"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <p className="field-hint">
          A few words to recognise this later. Search in Saved finds labels
          too. Leave empty to remove it.
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
export function SavedList({
  revision,
  project,
  teams,
  onOpen,
  onReply,
  renderResult,
  onUnsaveResult,
  searchLabel = "Search Saved",
}: {
  revision: number;
  project?: string;
  teams?: string;
  onOpen: (conversation: string, message?: string) => void;
  onReply: (message: SavedMessage) => void;
  renderResult: (item: Artifact, options: { onUnsave: () => void }) => ReactNode;
  onUnsaveResult: (item: Artifact) => Promise<void>;
  searchLabel?: string;
}) {
  type Shown = { saved: SavedItem[]; next: string | null; query: string };
  const shownKey = "saved:" + JSON.stringify([project, teams]);
  const shown = cachedView<Shown>(shownKey);
  const [saved, setSaved] = useState<SavedItem[] | null>(shown?.saved || null);
  const [next, setNext] = useState<string | null>(shown?.next || null);
  const [query, setQuery] = useState(shown?.query || "");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [labelling, setLabelling] = useState<SavedItem | null>(null);
  const request = useRef(0);
  const scope = (before?: string, text = query) => {
    const q = new URLSearchParams();
    if (project) q.set("folder", project);
    if (teams) q.set("teams", teams);
    if (text.trim()) q.set("q", text.trim());
    if (before) q.set("before", before);
    return q.toString();
  };
  async function load(text = query) {
    const ticket = ++request.current;
    // The account this request is for; a late answer for another is dropped.
    const owner = viewOwner();
    try {
      const page = await api<SavedPage>("/saved?" + scope(undefined, text));
      if (ticket !== request.current || owner !== viewOwner()) return;
      setSaved(page.items);
      setNext(page.next);
      cacheView<Shown>(
        shownKey,
        { saved: page.items, next: page.next, query: text },
        owner,
      );
      setError("");
    } catch (e) {
      if (ticket === request.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), query === (shown?.query || "") ? 0 : 250);
    return () => clearTimeout(timer);
  }, [revision, project, teams, query]);
  useEffect(() => {
    const update = () => void load();
    window.addEventListener("loop-later-change", update);
    window.addEventListener("loop-refresh", update);
    return () => {
      window.removeEventListener("loop-later-change", update);
      window.removeEventListener("loop-refresh", update);
    };
  }, [project, teams, query]);
  function unsave(item: SavedItem) {
    setRemoving((old) => new Set(old).add(item.key));
    const restore = () =>
      setRemoving((old) => {
        const next = new Set(old);
        next.delete(item.key);
        return next;
      });
    notify({
      text: "Removed from Saved.",
      undo: restore,
      onExpire: () => {
        const commit =
          item.kind === "message"
            ? api(`/messages/${item.message.message_id}/saved`, undefined, "DELETE")
            : onUnsaveResult(item.result);
        void Promise.resolve(commit)
          .then(() => {
            setSaved((old) => old?.filter((o) => o.key !== item.key) || null);
            restore();
          })
          .catch((e) => {
            restore();
            setError((e as Error).message);
          });
      },
    });
  }
  const labelRow = (item: SavedItem) => (
    <div className="saved-label-row">
      <Tag size={14} aria-hidden="true" />
      {item.label ? (
        <span className="saved-label">{item.label}</span>
      ) : null}
      <button
        type="button"
        className="text-button"
        aria-label={item.label ? `Edit label ${item.label}` : "Add a label"}
        onClick={() => setLabelling(item)}
      >
        {item.label ? "Edit" : "Add label"}
      </button>
      <span className="saved-when">
        Saved {relativeTime(item.saved_at).toLowerCase()}
      </span>
    </div>
  );
  // A saved message is laid out like a saved result: same card, same actions.
  const messageCard = (item: SavedItem & { kind: "message" }) => {
    const message = item.message;
    return (
      <Card
        agentName={message.role === "user" ? null : message.agent_name}
        provider={message.role === "user" ? null : message.provider}
        meta={`${dayLabel(message.created_at)} · ${timeLabel(message.created_at)}`}
        eyebrow={
          <>
            {message.role === "user" ? "Your message" : "Message"}
            {message.project_name && (
              <span className="card-project"> · {message.project_name}</span>
            )}
          </>
        }
        title={message.conversation_title}
        content={message.content || message.preview}
        onOpen={() => onOpen(message.conversation_id, message.message_id)}
        actions={
          <>
            <button onClick={() => onReply(message)}>
              <MessageSquare size={16} />
              Reply
            </button>
            <button
              aria-label="Remove from Saved"
              className="active"
              onClick={() => unsave(item)}
            >
              <Bookmark size={16} fill="currentColor" />
              Saved
            </button>
          </>
        }
      />
    );
  };
  const visible = (saved || []).filter((item) => !removing.has(item.key));
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
          type="search"
          enterKeyHint="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      {error && (
        <div className="error" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {visible.length ? (
        <div className="feed saved-feed">
          {visible.map((item) => (
            <div className="saved-item" key={item.key}>
              {labelRow(item)}
              {item.kind === "result" ? (
                <Fragment>
                  {renderResult(item.result, { onUnsave: () => unsave(item) })}
                </Fragment>
              ) : (
                messageCard(item)
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="section-empty">
          {!saved
            ? "Loading…"
            : query.trim()
              ? `Nothing saved matches “${query.trim()}”.`
              : "Tap Save on any result or message to keep it here."}
        </p>
      )}
      {next && (
        <button
          className="secondary load-more"
          onClick={async () => {
            try {
              const more = await api<SavedPage>("/saved?" + scope(next));
              setSaved((old) => [...(old || []), ...more.items]);
              setNext(more.next);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          More saved
        </button>
      )}
      {labelling && (
        <LabelSheet
          item={labelling}
          onClose={() => setLabelling(null)}
          onSaved={(label) => {
            setSaved(
              (old) =>
                old?.map((o) => (o.key === labelling.key ? { ...o, label } : o)) ||
                null,
            );
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
  onUnsaveResult,
  project,
  teams,
}: {
  revision: number;
  /** The same project and team scope as the results feed. */
  project?: string;
  teams?: string;
  onOpen: (conversation: string, message?: string) => void;
  onArtifact: (id: string) => void;
  onReply: (message: SavedMessage) => void;
  /** Put a message that could not be sent back into a draft. */
  onDraft: (item: ScheduledSend) => void;
  renderResult: (item: Artifact, options: { onUnsave: () => void }) => ReactNode;
  onUnsaveResult: (item: Artifact) => Promise<void>;
}) {
  type Reminders = { due: LaterView[]; upcoming: LaterView[] };
  const shown = cachedView<Reminders>("later:reminders");
  const [later, setLater] = useState<Reminders | null>(shown || null);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState("");
  const [snoozing, setSnoozing] = useState<LaterView | null>(null);
  const [section, setSectionState] = useState<LaterSection>(() => {
    const value = cachedView<string>("later-section");
    // Older links and cached views used "snoozed" for reminders.
    return value === "snoozed"
      ? "reminders"
      : ((value as LaterSection) || "all");
  });
  const [focus, setFocus] = useState<string | null>(
    () => cachedView<string | null>("later-focus") || null,
  );
  useEffect(() => cacheView("later-focus", null, viewOwner()), []);
  const setSection = (value: LaterSection) => {
    setSectionState(value);
    setFocus(null);
    cacheView("later-section", value, viewOwner());
  };
  async function load() {
    // The account this request is for; a late answer for another is dropped.
    const owner = viewOwner();
    try {
      const [items, scheduled] = await Promise.all([
        api<Reminders>("/later"),
        api<{ items: { state: string }[] }>("/scheduled-sends"),
      ]);
      if (owner !== viewOwner()) return;
      setLater(items);
      setFailed(scheduled.items.filter((i) => i.state === "failed").length);
      cacheView("later:reminders", items, owner);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const update = () => void load();
    window.addEventListener("loop-later-change", update);
    window.addEventListener("loop-scheduled-change", update);
    const timer = setInterval(update, 30_000);
    return () => {
      window.removeEventListener("loop-later-change", update);
      window.removeEventListener("loop-scheduled-change", update);
      clearInterval(timer);
    };
  }, [revision]);
  useEffect(() => {
    if (!focus || !later) return;
    const node = document.getElementById("later-" + focus);
    node?.scrollIntoView({ block: "center" });
    node?.focus({ preventScroll: true });
  }, [focus, !!later]);
  function open(item: LaterView) {
    if (item.kind === "artifact") onArtifact(item.target_id);
    else if (item.conversation_id)
      onOpen(item.conversation_id, item.message_id || undefined);
  }
  async function done(item: LaterView, due: boolean) {
    try {
      await api("/later/" + item.id, undefined, "DELETE");
      window.dispatchEvent(new Event("loop-later-change"));
      // Undo reopens this same reminder: Done is a state, not a deletion.
      notify({
        text: due ? "Marked done." : "Reminder cancelled.",
        undo: async () => {
          await api(`/later/${item.id}/reopen`, {});
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
        provider={item.provider}
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
              aria-label={due ? `Done with ${item.title}` : `Cancel reminder for ${item.title}`}
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
  const show = (value: LaterSection) => section === "all" || section === value;
  const counts: Partial<Record<LaterSection, number>> = {
    reminders: later?.due.length || 0,
    scheduled: failed,
  };
  return (
    <section className="later-page" aria-label="Later">
      <div className="chip-row later-sections" role="tablist" aria-label="Show">
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
            className={"chip" + (value === "scheduled" && failed ? " attention" : "")}
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
      {error && (
        <div className="error" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {show("reminders") && (
        <>
          <h2 className="section-title">Reminders</h2>
          <p className="section-hint">
            Items brought back to you. Nothing is sent to an agent.
          </p>
          {!!later?.due.length && (
            <>
              <h3 className="section-subtitle">Back now</h3>
              <div className="feed">{later.due.map((i) => reminderCard(i, true))}</div>
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
                  ? "Use “Remind me” on a thread, result or message, or swipe a thread left."
                  : "Loading…"}
              </p>
            )
          )}
        </>
      )}
      {show("scheduled") && (
        <>
          <h2 className="section-title">Scheduled</h2>
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
          <h2 className="section-title">Saved</h2>
          <SavedList
            revision={revision}
            project={project}
            teams={teams}
            onOpen={onOpen}
            onReply={onReply}
            renderResult={renderResult}
            onUnsaveResult={onUnsaveResult}
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
