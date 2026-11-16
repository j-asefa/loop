import { ErrorNotice } from "./ErrorNotice";
import { emitClientEvent, listenClientEvent } from "./clientEvents";
import { useProjectionRoute } from "./SourceContext";
import { LaterTargetInput } from "../shared/contract-ids";
import {
  ConversationId,
  ProjectId,
  parseId,
  LaterItemId,
} from "../shared/contract-ids.js";
import { proseEntry } from "./textEntry";
import { useSourceRoute, useSourceId } from "./SourceContext";
import { useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  Clock3,
  MessageSquareQuote,
  PencilLine,
  Reply,
  Trash2,
} from "lucide-react";
import { callRoute, readRoute } from "./api";
import { CollectionReadNotice, useCollectionRead } from "./CollectionRead";
import { listenWorkspaceChanges } from "./workspace-changes";
import {
  workspaceApi,
  type RouteInput,
  type RouteResponse,
} from "../shared/workspace-api";
import { viewOwner } from "./viewCache";
import { executionSourceId } from "./sourceRouting";
import { RichText, Sheet } from "./components";

import {
  dayLabel,
  laterChoices,
  localInputValue,
  timeLabel,
} from "./threadView";

/** A reminder Loop created, for the confirmation's link and Undo. */
type CreatedReminder = Required<
  Pick<RouteResponse<typeof workspaceApi.laterCreate>, "id" | "replaced">
>;

/**
 * Remind me: time presets, "when it finishes", "next time I open the
 * project", or a custom time. A reminder only brings the item back to you;
 * nothing is sent to an agent. With `itemId` it snoozes that reminder again.
 */
export function LaterSheet({
  kind,
  targetId,
  itemId,
  title,
  running,
  project,
  sourceId,
  onClose,
  onDone,
}: {
  kind: "conversation" | "artifact" | "message" | "story";
  targetId: string;
  /** Snooze this existing reminder again instead of creating one. */
  itemId?: string;
  title: string;
  running?: boolean;
  project?: { id: string; name: string };
  sourceId?: string;
  onClose: () => void;
  onDone: (label: string, created: CreatedReminder) => void;
}) {
  const scopedSource = useSourceId();
  const owner = viewOwner();
  const requestKey = JSON.stringify([
    owner,
    sourceId ?? scopedSource,
    kind,
    targetId,
    itemId,
  ]);
  const active = useRef(requestKey);
  active.current = requestKey;
  const current = () => active.current === requestKey && viewOwner() === owner;
  useEffect(() => {
    active.current = requestKey;
    return () => {
      if (active.current === requestKey) active.current = "";
    };
  }, [requestKey]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState(() =>
    localInputValue(Date.now() + 2 * 3600_000),
  );
  const choices = laterChoices(Date.now(), { running, project });
  async function save(
    condition: "time" | "run_finished" | "project_open",
    dueAt: number | undefined,
    label: string,
  ) {
    if (busy || !current()) return;
    setBusy(true);
    setError("");
    const trigger = {
      condition,
      dueAt,
      projectId: parseId(
        ProjectId,
        condition === "project_open" ? project?.id : undefined,
      ),
    };
    try {
      const created: CreatedReminder = itemId
        ? await callRoute(
            workspaceApi.laterSnooze,
            { params: { id: LaterItemId.parse(itemId) }, body: trigger },
            sourceId ?? scopedSource,
          ).then((row) => ({ id: row.id, replaced: null }))
        : await callRoute(
            workspaceApi.laterCreate,
            {
              body: {
                kind,
                targetId: LaterTargetInput.parse(targetId),
                ...trigger,
              },
            },
            sourceId ?? scopedSource,
          ).then((row) => ({ id: row.id, replaced: row.replaced ?? null }));
      if (!current()) return;
      emitClientEvent("loop-later-change");
      onDone(label, created);
      onClose();
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <Sheet
      title={itemId ? "Snooze again" : "Remind me"}
      onClose={onClose}
      className="action-sheet"
    >
      <p className="later-target">
        <strong>{title}</strong>
        <small>
          Brings this back to you in Later → Reminders. Nothing is sent to an
          agent.
        </small>
      </p>
      <div className="action-list">
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            disabled={busy}
            onClick={() =>
              void save(choice.condition, choice.dueAt, choice.label)
            }
          >
            <Clock3 size={20} />
            <span>
              {choice.label}
              {choice.hint && <small>{choice.hint}</small>}
            </span>
          </button>
        ))}
      </div>
      <label className="later-custom">
        Pick a time
        <span>
          <input
            type="datetime-local"
            value={custom}
            min={localInputValue(Date.now())}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            className="secondary"
            disabled={busy || !custom}
            onClick={() => {
              const at = new Date(custom).getTime();
              if (!(at > Date.now())) {
                setError("Choose a time in the future.");
                return;
              }
              void save("time", at, `${dayLabel(at)} at ${timeLabel(at)}`);
            }}
          >
            Set
          </button>
        </span>
      </label>
      {error && <ErrorNotice role="alert">{error}</ErrorNotice>}
    </Sheet>
  );
}

/**
 * Undo a reminder Loop just created: cancel it, and reopen the reminder it
 * replaced, if any. Both are true reversals: nothing was sent anywhere.
 */
export async function undoReminder(
  created: CreatedReminder,
  sourceId = executionSourceId(),
) {
  await callRoute(
    workspaceApi.laterFinish,
    { params: { id: created.id }, body: undefined },
    sourceId,
  );
  if (created.replaced)
    await callRoute(
      workspaceApi.laterReopen,
      { params: { id: created.replaced }, body: {} },
      sourceId,
    ).catch(() => {});
  emitClientEvent("loop-later-change");
}

export type ScheduledSend = RouteResponse<
  typeof workspaceApi.scheduledSendList
>["items"][number];

/**
 * Change the text or time of a message that has not been sent yet. A
 * message that could not be sent is scheduled again at the new time.
 */
function EditScheduled({
  item,
  onClose,
  onSaved,
}: {
  item: ScheduledSend;
  onClose: () => void;
  onSaved: () => void;
}) {
  const call = useSourceRoute();
  const failed = item.state === "failed";
  const [text, setText] = useState(item.input);
  const [at, setAt] = useState(
    localInputValue(failed ? Date.now() + 3600_000 : item.send_at),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet
      title={failed ? "Edit and schedule again" : "Edit scheduled message"}
      onClose={onClose}
    >
      <p className="field-hint">
        To {item.agent_name ? "@" + item.agent_name : "the agent"}
        {item.folder_name ? ` · ${item.folder_name}` : ""} ·{" "}
        {item.conversation_title || "New thread"}
      </p>
      <label>
        Message
        <textarea
          {...proseEntry}
          value={text}
          rows={6}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label>
        Send at
        <input
          type="datetime-local"
          value={at}
          min={localInputValue(Date.now())}
          onChange={(e) => setAt(e.target.value)}
        />
      </label>
      {failed && (
        <p className="field-hint">
          Nothing was sent before. It sends once, at the new time, if Loop
          accepts it then.
        </p>
      )}
      {error && <ErrorNotice role="alert">{error}</ErrorNotice>}
      <button
        className="primary"
        disabled={busy || !text.trim() || !at}
        onClick={async () => {
          if (busy) return;
          const sendAt = new Date(at).getTime();
          if (!(sendAt > Date.now())) {
            setError("Choose a time in the future.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            await call(workspaceApi.scheduledSendUpdate, {
              params: { id: item.id },
              body: { input: text, sendAt },
            });
            onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {failed ? "Schedule again" : "Save"}
      </button>
    </Sheet>
  );
}

/**
 * Scheduled messages that still need you: waiting to send (edit or cancel),
 * or not sent because Loop refused them when due (edit, send now, move to a
 * draft or dismiss). In a thread they read like your own messages;
 * owner-wide (Later) each also names its recipient and where it goes.
 */
export function ScheduledSends({
  conversationId,
  revision,
  onOpen,
  onDraft,
  focusId,
  failedOnly = false,
}: {
  conversationId?: string;
  revision: number;
  onOpen?: (conversationId: string) => void;
  /** Put a message that could not be sent back into a draft. */
  onDraft?: (item: ScheduledSend) => void;
  /** Highlight this item: the one a confirmation linked to. */
  focusId?: string | null;
  /** Only messages that could not be sent (for Needs you). */
  failedOnly?: boolean;
}) {
  const readProjection = useProjectionRoute();

  const call = useSourceRoute();
  const sourceId = useSourceId();
  const recovery = useCollectionRead(
    JSON.stringify([sourceId, conversationId]),
  );
  const read = recovery.load;
  const [all, setItems] = useState<ScheduledSend[]>([]);
  // Older messages that could not be sent load a page at a time.
  const [failedNext, setFailedNext] = useState<string | null>(null);
  const items = failedOnly
    ? all.filter((item) => item.state === "failed")
    : all;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setItems([]);
    setFailedNext(null);
    setLoaded(false);
  }, [read]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ScheduledSend | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const query = (
    failedBefore?: string,
  ): RouteInput<typeof workspaceApi.scheduledSendList>["query"] => ({
    conversation: parseId(ConversationId, conversationId) || undefined,
    failedBefore,
  });
  const load = (manual = false) =>
    read(
      (signal, mode) =>
        readRoute(
          workspaceApi.scheduledSendList,
          { query: query() },
          sourceId,
          signal,
          undefined,
          mode,
        ),
      (result) => {
        setItems(result.items);
        setFailedNext(result.failed_next);
        setLoaded(true);
      },
      manual,
    );
  const loadOlder = async () => {
    if (!failedNext) return;
    try {
      const page = await readProjection(
        workspaceApi.scheduledSendList,
        {
          query: query(failedNext),
        },
        { mode: "once" },
      );
      setItems((old) => {
        const failed = old.filter((item) => item.state === "failed");
        return [
          ...failed,
          ...page.items.filter((item) => !failed.some((f) => f.id === item.id)),
          ...old.filter((item) => item.state !== "failed"),
        ];
      });
      setFailedNext(page.failed_next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const refresh = () => void load();
    const stopChanges = listenWorkspaceChanges("scheduled", refresh, sourceId);
    const stopScheduledEvent = listenClientEvent(
      "loop-scheduled-change",
      refresh,
    );
    return () => {
      stopChanges();
      stopScheduledEvent();
    };
  }, [conversationId, sourceId, read]);
  // Scroll to the item a confirmation linked to, once it is listed.
  useEffect(() => {
    if (!focusId || !items.some((item) => item.id === focusId)) return;
    const node = document.getElementById("scheduled-" + focusId);
    node?.scrollIntoView({ block: "center" });
    node?.focus({ preventScroll: true });
  }, [focusId, items.length]);
  const act = async (item: ScheduledSend, action: "cancel" | "retry") => {
    if (busy) return;
    setBusy(item.id);
    setError("");
    try {
      if (action === "cancel")
        await call(workspaceApi.scheduledSendCancel, {
          params: { id: item.id },
          body: undefined,
        });
      else {
        const result = await call(workspaceApi.scheduledSendRetry, {
          params: { id: item.id },
          body: {},
        });
        if (!result.run)
          setError(result.row.error || "Loop could not send this message.");
      }
      await load();
      emitClientEvent("loop-scheduled-change");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const global = !conversationId;
  const readNotice = (
    <CollectionReadNotice {...recovery} retry={() => void load(true)} />
  );
  if (failedOnly && !items.length) return readNotice;
  if (global && !loaded)
    return recovery.error ? (
      readNotice
    ) : (
      <p className="section-empty">Loading…</p>
    );
  if (!items.length)
    return global ? (
      <>
        {readNotice}
        <p className="section-empty">
          Nothing scheduled. Use “Send later” in the composer to schedule a
          message to an agent.
        </p>
      </>
    ) : (
      readNotice
    );
  return (
    <section className="scheduled-sends" aria-label="Scheduled messages">
      {readNotice}
      {items.map((item) => {
        const failed = item.state === "failed";
        const where = [
          item.agent_name && "To @" + item.agent_name,
          item.folder_name || "Unfiled",
          item.conversation_title || "New thread",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <article
            key={item.id}
            id={"scheduled-" + item.id}
            tabIndex={-1}
            className={
              "message user scheduled-message" +
              (failed ? " not-sent" : "") +
              (focusId === item.id ? " anchored" : "")
            }
          >
            <header className="message-meta">
              <span className="eyebrow">
                {failed ? "Not sent" : "You · Waiting to send"}
              </span>
              <span className="message-meta-end">
                {failed ? (
                  <CircleAlert size={14} aria-hidden="true" />
                ) : (
                  <Clock3 size={14} aria-hidden="true" />
                )}
                <time dateTime={new Date(item.send_at).toISOString()}>
                  {failed ? "Was due" : "Sends"}{" "}
                  {dayLabel(item.send_at).toLowerCase()} at{" "}
                  {timeLabel(item.send_at)}
                </time>
              </span>
            </header>
            {global && <p className="field-hint">{where}</p>}
            <RichText content={item.input} />
            {failed && (
              <ErrorNotice role="status">
                Loop could not send this: {item.error || "it was refused."}{" "}
                Nothing was sent, and Loop will not retry it on its own.
              </ErrorNotice>
            )}
            <div className="scheduled-actions">
              <button
                type="button"
                className="text-button"
                aria-label={
                  failed ? "Edit and schedule again" : "Edit scheduled message"
                }
                onClick={() => setEditing(item)}
              >
                <PencilLine size={16} /> Edit
              </button>
              {failed && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy === item.id}
                  onClick={() => void act(item, "retry")}
                >
                  <Reply size={16} /> Send now
                </button>
              )}
              {failed && onDraft && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onDraft(item)}
                >
                  <MessageSquareQuote size={16} /> Copy to a draft
                </button>
              )}
              <button
                type="button"
                className="text-button"
                aria-label={
                  failed ? "Dismiss message" : "Cancel scheduled message"
                }
                disabled={busy === item.id}
                onClick={() => void act(item, "cancel")}
              >
                <Trash2 size={16} /> {failed ? "Dismiss" : "Cancel"}
              </button>
              {global && item.conversation_id && onOpen && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onOpen(item.conversation_id!)}
                >
                  Open thread
                </button>
              )}
            </div>
          </article>
        );
      })}
      {failedNext && (
        <button
          type="button"
          className="secondary load-more"
          onClick={() => void loadOlder()}
        >
          More not sent
        </button>
      )}
      {error && <ErrorNotice role="alert">{error}</ErrorNotice>}
      {editing && (
        <EditScheduled
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void load();
            emitClientEvent("loop-scheduled-change");
          }}
        />
      )}
    </section>
  );
}
