import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  AlarmClock,
  ArrowUpRight,
  Bookmark,
  Check,
  Clock3,
  MessageSquare,
} from "lucide-react";
import { api } from "./api";
import { cacheView, cachedView, viewOwner } from "./viewCache";
import { ScheduledSends } from "./ThreadTools";
import type { Artifact } from "../shared/types";
import { Avatar, RichText } from "./components";
import { dayLabel, relativeTime, timeLabel } from "./threadView";

type LaterView = {
  id: string;
  kind: "conversation" | "artifact" | "message";
  target_id: string;
  condition: "time" | "run_finished" | "project_open";
  due_at: number | null;
  surfaced_at: number | null;
  created_at: number;
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
type SavedItem = { key: string; saved_at: number } & (
  | { kind: "message"; message: SavedMessage }
  | { kind: "result"; result: Artifact }
);
type SavedPage = { items: SavedItem[]; next: string | null };

function when(item: LaterView) {
  if (item.condition === "run_finished") return "When the agent finishes";
  if (item.condition === "project_open")
    return `Next time you open ${item.project_name || "the project"}`;
  if (!item.due_at) return "";
  return `${dayLabel(item.due_at)} at ${timeLabel(item.due_at)}`;
}

export function Later({
  revision,
  onOpen,
  onArtifact,
  onReply,
  renderResult,
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
  renderResult: (item: Artifact) => ReactNode;
}) {
  type Shown = {
    later: { due: LaterView[]; upcoming: LaterView[] };
    saved: SavedItem[];
    next: string | null;
  };
  const shownKey = "later:" + JSON.stringify([project, teams]);
  // Going back shows Later as you left it, on the same section, while it refreshes.
  const shown = cachedView<Shown>(shownKey);
  const [later, setLater] = useState<Shown["later"] | null>(shown?.later || null);
  const [saved, setSaved] = useState<SavedItem[] | null>(shown?.saved || null);
  const [next, setNext] = useState<string | null>(shown?.next || null);
  const [error, setError] = useState("");
  const [section, setSectionState] = useState<
    "all" | "snoozed" | "scheduled" | "saved"
  >(
    cachedView("later-section") || "all",
  );
  const setSection = (value: typeof section) => {
    setSectionState(value);
    cacheView("later-section", value, viewOwner());
  };
  const scope = (before?: string) => {
    const q = new URLSearchParams();
    if (project) q.set("folder", project);
    if (teams) q.set("teams", teams);
    if (before) q.set("before", before);
    return q.toString();
  };
  async function load() {
    // The account this request is for; a late answer for another is dropped.
    const owner = viewOwner();
    try {
      const [items, page] = await Promise.all([
        api<{ due: LaterView[]; upcoming: LaterView[] }>("/later"),
        api<SavedPage>("/saved?" + scope()),
      ]);
      if (owner !== viewOwner()) return;
      setLater(items);
      setSaved(page.items);
      setNext(page.next);
      cacheView<Shown>(
        shownKey,
        { later: items, saved: page.items, next: page.next },
        owner,
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const update = () => void load();
    window.addEventListener("loop-later-change", update);
    const timer = setInterval(update, 30_000);
    return () => {
      window.removeEventListener("loop-later-change", update);
      clearInterval(timer);
    };
  }, [revision, project, teams]);
  function open(item: LaterView) {
    if (item.kind === "artifact") onArtifact(item.target_id);
    else if (item.conversation_id)
      onOpen(item.conversation_id, item.message_id || undefined);
  }
  async function done(item: LaterView) {
    try {
      await api("/later/" + item.id, undefined, "DELETE");
      window.dispatchEvent(new Event("loop-later-change"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // Every Later item is a full-size card, matching result and inbox cards.
  const card = ({
    key,
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
  }: {
    key: string;
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
  }) => (
    <article key={key} className={"feed-card later-card" + (due ? " due" : "")}>
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
  async function unsave(message: SavedMessage) {
    try {
      await api(`/messages/${message.message_id}/saved`, undefined, "DELETE");
      setSaved(
        (old) =>
          old?.filter(
            (item) =>
              item.kind !== "message" ||
              item.message.message_id !== message.message_id,
          ) || null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // A saved message is laid out like a saved result: same card, same actions.
  const messageCard = (key: string, message: SavedMessage) =>
    card({
      key,
      agentName: message.role === "user" ? null : message.agent_name,
      provider: message.role === "user" ? null : message.provider,
      meta: `${dayLabel(message.created_at)} · ${timeLabel(message.created_at)}`,
      eyebrow: (
        <>
          {message.role === "user" ? "Your message" : "Message"}
          {message.project_name && (
            <span className="card-project"> · {message.project_name}</span>
          )}
        </>
      ),
      title: message.conversation_title,
      content: message.content || message.preview,
      onOpen: () => onOpen(message.conversation_id, message.message_id),
      actions: (
        <>
          <button onClick={() => onReply(message)}>
            <MessageSquare size={16} />
            Reply
          </button>
          <button
            aria-label="Remove from Saved"
            className="active"
            onClick={() => void unsave(message)}
          >
            <Bookmark size={16} fill="currentColor" />
            Saved
          </button>
        </>
      ),
    });
  const laterCard = (item: LaterView, due: boolean) =>
    card({
      key: item.id,
      agentName: item.agent_name,
      provider: item.provider,
      meta: due
        ? `Back ${relativeTime(item.surfaced_at || item.created_at).toLowerCase()}`
        : when(item),
      eyebrow: (
        <>
          {due ? <AlarmClock size={13} /> : <Clock3 size={13} />}{" "}
          {due ? "Back now" : "Snoozed"}
          {item.project_name && (
            <span className="card-project"> · {item.project_name}</span>
          )}
        </>
      ),
      title: item.title,
      content: item.content || item.preview,
      onOpen: () => open(item),
      due,
      action: (
        <button
          type="button"
          className="text-button later-done"
          aria-label={due ? `Done with ${item.title}` : `Cancel reminder for ${item.title}`}
          onClick={() => void done(item)}
        >
          <Check size={16} /> {due ? "Done" : "Cancel"}
        </button>
      ),
    });
  const show = (value: typeof section) => section === "all" || section === value;
  return (
    <section className="later-page" aria-label="Later">
      <div className="chip-row" role="tablist" aria-label="Show">
        {(
          [
            ["all", "Everything"],
            ["snoozed", "Snoozed"],
            ["scheduled", "Scheduled"],
            ["saved", "Saved"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            className="chip"
            aria-selected={section === value}
            onClick={() => setSection(value)}
          >
            {label}
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
      {show("snoozed") && (
        <>
          {!!later?.due.length && (
            <>
              <h2 className="section-title">Back now</h2>
              <div className="feed">{later.due.map((i) => laterCard(i, true))}</div>
            </>
          )}
          <h2 className="section-title">Snoozed</h2>
          {later?.upcoming.length ? (
            <div className="feed">
              {later.upcoming.map((i) => laterCard(i, false))}
            </div>
          ) : (
            <p className="section-empty">
              {later ? "Swipe a thread left, or use “Remind me later” in any menu, to snooze it." : "Loading…"}
            </p>
          )}
        </>
      )}
      {show("scheduled") && (
        <>
          <h2 className="section-title">Scheduled</h2>
          <ScheduledSends revision={revision} onOpen={(c) => onOpen(c)} />
        </>
      )}
      {show("saved") && (
        <>
          <h2 className="section-title">Saved</h2>
          {saved?.length ? (
            <div className="feed">
              {saved.map((item) =>
                item.kind === "result" ? (
                  <Fragment key={item.key}>{renderResult(item.result)}</Fragment>
                ) : (
                  messageCard(item.key, item.message)
                ),
              )}
            </div>
          ) : (
            <p className="section-empty">
              {saved
                ? "Tap Save on any result or message to keep it here."
                : "Loading…"}
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
        </>
      )}
    </section>
  );
}
