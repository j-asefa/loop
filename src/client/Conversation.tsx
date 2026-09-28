import {
  useConversationActivities,
  visibleActivities,
  recordedSessionControls,
} from "./activityView";
import { ActivityRecords } from "./ActivityRecords";
import { SessionActivityControls } from "./SessionActivityControls";
import type { ActivityRecord } from "../agent-activities";
import {
  mergeConversationMessages,
  conversationRefreshCursor,
  type ConversationMessage,
} from "./conversationMessages";
import { AgentModelSettings } from "./AgentModelSettings";
import { agentModelName } from "./modelChoices";
import { AttachmentList } from "./Attachments";
import type { ComposerContext } from "./composerContext";
import { NativeDecisions } from "./NativeControls";
import { Approvals } from "./Approvals";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown, Copy, MoreHorizontal, Reply } from "lucide-react";
import { api, parse } from "./api";
import { Sheet, RichText, Avatar } from "./components";
import type { Agent, Connection, Message, Team } from "../shared/types";
import { RunStatus } from "./RunStatus";
import { RunFiles } from "./PublishedFiles";
import { NativeConversation, MemoryUsed } from "./Memory";

// Keep the transcript focused on public messages, plans and files. Raw tool
// calls and command output are available separately from the options menu.
const conversationActivity = (record: ActivityRecord) =>
  record.kind !== "tool" && record.kind !== "output";

export function Conversation({
  id,
  messageId,
  revision,
  agents,
  connections,
  teams,
  onClose,
  onContinue,
  composer,
  onReady,
  onReply,
  onUsePrompt,
  onSubmitted,
  onProfile,
  onAgentChanged,
  onNewConversation,
}: {
  id: string;
  messageId?: string | null;
  revision: number;
  agents: Agent[];
  connections: Connection[];
  teams: Team[];
  onClose: () => void;
  onContinue: (id: string) => void;
  composer: ReactNode;
  onReady: (context: ComposerContext) => void;
  onReply: (context: ComposerContext) => void;
  onUsePrompt: (text: string) => void;
  onSubmitted: () => void;
  onProfile: (agent: Agent) => void;
  onAgentChanged?: () => void;
  onNewConversation: (agent: Agent) => void;
}) {
  const activityItems = useConversationActivities(id);
  const allActivities = visibleActivities(activityItems);
  const activities = allActivities.filter((item) =>
    conversationActivity(item.record),
  );
  const toolActivities = allActivities.filter(
    (item) => !conversationActivity(item.record),
  );
  const [data, setData] = useState<{
      conversation: any;
      messages: ConversationMessage[];
      next: string | null;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [transfer, setTransfer] = useState(false),
    [destination, setDestination] = useState(""),
    [included, setIncluded] = useState<string[]>([]),
    [editingModel, setEditingModel] = useState(false),
    [showToolActivity, setShowToolActivity] = useState(false);
  const [newProvider, setNewProvider] = useState<Agent | null>(null);
  const anchor = messageId;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const generation = useRef(0);
  const anchoring = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const initialScroll = useRef<string | null>(null);
  const followLatest = useRef(!anchor);
  const pinnedSize = useRef({ height: 0, viewport: 0 });
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const retryKeys = useRef(new Map<string, string>());
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryBusy = useRef(false);
  const paging = useRef(false);
  const loadRequest = useRef(0);
  const refreshRequest = useRef<{
    generation: number;
    queued: boolean;
  } | null>(null);
  const seenRevision = useRef(revision);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const agent = agents.find((a) => a.id === data?.conversation.agent_id),
    imported = data?.conversation.origin.endsWith("-import");
  function pinLatest() {
    const messages = messagesRef.current;
    if (!messages) return;
    pinnedSize.current = {
      height: messages.scrollHeight,
      viewport: messages.clientHeight,
    };
    messages.scrollTop = messages.scrollHeight;
  }
  async function load(initial = false) {
    if (paging.current) return;
    const current = generation.current;
    if (refreshRequest.current?.generation === current) {
      refreshRequest.current.queued = true;
      return;
    }
    const request = { generation: current, queued: false };
    refreshRequest.current = request;
    const ticket = ++loadRequest.current;
    if (initial) setLoading(true);
    try {
      const fresh = await api(
        "/conversations/" +
          id +
          (initial && anchor ? "?message=" + anchor : ""),
      );
      if (current !== generation.current || ticket !== loadRequest.current)
        return;
      setLoadError("");
      setData((old) =>
        !initial && old
          ? {
              ...fresh,
              messages: mergeConversationMessages(old.messages, fresh.messages),
              next: conversationRefreshCursor(
                old.messages,
                fresh.messages,
                old.next,
                fresh.next,
              ),
            }
          : fresh,
      );
      if (initial)
        setIncluded(
          fresh.messages
            .filter(
              (m: Message) =>
                parse<any>(m.metadata, {}).activeBranch !== false &&
                !parse<any>(m.metadata, {}).progress,
            )
            .map((m: Message) => m.id),
        );
    } catch (e) {
      if (current === generation.current && ticket === loadRequest.current)
        setLoadError((e as Error).message);
    } finally {
      if (current === generation.current && ticket === loadRequest.current)
        setLoading(false);
      if (refreshRequest.current === request) {
        refreshRequest.current = null;
        if (current === generation.current && request.queued) void load();
      }
    }
  }
  useEffect(() => {
    generation.current++;
    anchoring.current = false;
    followLatest.current = !anchor;
    setAwayFromLatest(false);
    setData(null);
    setTransfer(false);
    setShowToolActivity(false);
    setError("");
    setNotice("");
    void load(true);
    const update = () => void load();
    const timer = setInterval(update, 5000);
    window.addEventListener("loop-workspace-change", update);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener("loop-workspace-change", update);
    };
  }, [id, anchor]);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    void load();
  }, [revision]);
  useEffect(() => {
    if (!imported && agent && data?.conversation.id === id)
      readyRef.current({
        agentId: agent.id,
        conversationId: id,
        title: data.conversation.title,
      });
  }, [id, agent?.id, data?.conversation.title, imported]);
  useLayoutEffect(() => {
    if (data?.conversation.id !== id) return;
    const messages = messagesRef.current;
    if (!messages) return;
    if (followLatest.current) pinLatest();
    initialScroll.current = id;
  }, [data, id, anchor]);
  useEffect(() => {
    const messages = messagesRef.current;
    if (!messages) return;
    // Keep the current output in view when the composer or mobile keyboard
    // changes the available height, unless the user is reading older messages.
    const observer = new ResizeObserver(() => {
      if (followLatest.current && initialScroll.current === id) pinLatest();
    });
    observer.observe(messages);
    return () => observer.disconnect();
  }, [id]);
  useEffect(() => {
    if (!anchor || data?.conversation.id !== id) return;
    const messages = messagesRef.current;
    const message = document.getElementById("message-" + anchor);
    if (!messages || !message) return;
    anchoring.current = true;
    followLatest.current = false;
    let frame = 0;
    let focused = false;
    const align = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!anchoring.current) return;
        message.scrollIntoView({ block: "center" });
        setAwayFromLatest(
          messages.scrollHeight - messages.clientHeight - messages.scrollTop >= 48,
        );
        if (!focused) message.focus({ preventScroll: true });
        focused = true;
      });
    };
    // Opening the composer and rendering a diagram can change the scrollport
    // after the first frame. Keep the link target visible until the user takes over.
    const observer = new ResizeObserver(align);
    observer.observe(messages);
    observer.observe(message);
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"];
    const stop = () => {
      anchoring.current = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const input of inputs) messages.removeEventListener(input, stop);
    };
    for (const input of inputs)
      messages.addEventListener(input, stop, { passive: true });
    align();
    return stop;
  }, [data?.conversation.id, id, anchor]);
  return (
    <Sheet
      wide
      swipeToClose
      className="conversation-sheet"
      title={data?.conversation.title || "Conversation"}
      onClose={onClose}
    >
      <div className="conversation-meta">
        {agent ? (
          <button
            className="conversation-agent"
            aria-label={`Open @${agent.name} profile`}
            onClick={() => onProfile(agent)}
          >
            <Avatar name={agent.name} provider={agent.provider} />
            <span className="conversation-agent-copy">
              <strong>@{agent.name}</strong>
              <span className="conversation-agent-details">
                <span title={agentModelName(agent, connections)}>
                  {agentModelName(agent, connections)}
                </span>
              </span>
            </span>
          </button>
        ) : (
          <span className="muted">
            {loading ? "Loading agent…" : "Agent unavailable"}
          </span>
        )}
        <details className="conversation-options">
          <summary aria-label="Conversation options">
            <MoreHorizontal size={20} />
          </summary>
          <div className="conversation-options-menu">
            <NativeConversation id={id} />
            {!!toolActivities.length && (
              <button
                className="text-button"
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setShowToolActivity(true);
                }}
              >
                Tool activity
              </button>
            )}
            <SessionActivityControls
              key={id}
              conversationId={id}
              recorded={recordedSessionControls(activityItems)}
            />
            {agent && (
              <button
                className="text-button"
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setError("");
                  setEditingModel(true);
                }}
              >
                Change model
              </button>
            )}
            <button
              className="text-button"
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                setError("");
                setTransfer(true);
              }}
            >
              Continue with another agent
            </button>
          </div>
        </details>
      </div>
      {showToolActivity && (
        <Sheet title="Tool activity" onClose={() => setShowToolActivity(false)}>
          <ActivityRecords
            records={toolActivities.map((item) => item.record)}
          />
        </Sheet>
      )}
      {editingModel && agent && (
        <AgentModelSettings
          agent={agent}
          connections={connections}
          onClose={() => {
            setEditingModel(false);
            if (newProvider) onNewConversation(newProvider);
          }}
          onSaved={(saved) => {
            onAgentChanged?.();
            if (saved.connection_id !== agent.connection_id || newProvider)
              setNewProvider(saved);
            else setNotice("Model updated for your next message.");
          }}
        />
      )}
      <div className="conversation-message-area">
        <div
          className="messages"
          ref={messagesRef}
          aria-busy={loading}
          onScroll={(event) => {
            if (anchoring.current) return;
            const el = event.currentTarget;
            // A composer resize can emit the preceding programmatic scroll
            // event with new dimensions. It is not a request to stop following.
            if (
              followLatest.current &&
              (pinnedSize.current.height !== el.scrollHeight ||
                pinnedSize.current.viewport !== el.clientHeight)
            ) {
              pinLatest();
              return;
            }
            const following =
              el.scrollHeight - el.clientHeight - el.scrollTop < 48;
            followLatest.current = following;
            setAwayFromLatest(!following);
          }}
        >
          {loading && (
            <p role="status" className="muted">
              Loading conversation…
            </p>
          )}
          {loadError && (
            <div role="alert" className="error">
              {loadError}
              <button className="text-button" onClick={() => void load(!data)}>
                Try again
              </button>
            </div>
          )}
          {data?.next && (
            <button
              className="text-button"
              disabled={loadingEarlier}
              onClick={async () => {
                if (paging.current) return;
                paging.current = true;
                loadRequest.current++;
                setLoadingEarlier(true);
                const current = generation.current;
                try {
                  const older = await api(
                    "/conversations/" + id + "?before=" + data.next,
                  );
                  if (current !== generation.current) return;
                  setData((previous) =>
                    previous
                      ? {
                          ...previous,
                          messages: mergeConversationMessages(
                            previous.messages,
                            older.messages,
                          ),
                          next: older.next,
                        }
                      : previous,
                  );
                  setError("");
                } catch (e) {
                  if (current === generation.current)
                    setError((e as Error).message);
                } finally {
                  paging.current = false;
                  if (current === generation.current) {
                    setLoadingEarlier(false);
                    void load();
                  }
                }
              }}
            >
              Load earlier messages
            </button>
          )}
          <ActivityRecords
            records={activities.filter((a) => !a.run).map((a) => a.record)}
          />
          {data?.messages.map((m) => {
            const meta = parse<any>(m.metadata, {});
            const pendingAnswer =
              m.role === "assistant" &&
              !meta.progress &&
              (meta.partial === true || !m.content.trim());
            // Current runtimes stream public text as message traces. Older
            // records may only have partial answer text; display it if there is
            // no trace for that run, without duplicating the current stream.
            const showContent =
              m.content &&
              (meta.partial !== true ||
                !data.messages.some(
                  (other) =>
                    other.run_id === m.run_id &&
                    parse<any>(other.metadata, {}).progress,
                ));
            return (
              <article
                key={m.id}
                id={"message-" + m.id}
                tabIndex={-1}
                className={
                  "message " +
                  m.role +
                  (pendingAnswer ? " pending-answer" : "") +
                  (parse<any>(m.metadata, {}).progress
                    ? " agent-progress"
                    : "") +
                  (anchor === m.id ? " anchored" : "")
                }
              >
                {(!pendingAnswer || showContent) && (
                  <header className="message-meta">
                    <span className="eyebrow">
                      {m.role === "user" ? "You" : `@${agent?.name || "agent"}`}
                      {parse<any>(m.metadata, {}).progress ? " · Update" : ""}
                      {parse<any>(m.metadata, {}).activeBranch === false
                        ? " · alternate branch"
                        : ""}
                    </span>
                    <time
                      dateTime={new Date(m.created_at).toISOString()}
                      title={new Date(m.created_at).toLocaleString()}
                    >
                      {new Date(m.created_at).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                      })}
                      {" · "}
                      {new Date(m.created_at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </header>
                )}
                {m.role === "user" && parse<any>(m.metadata, {}).replyTo && (
                  <details className="message-reply-context">
                    <summary>
                      Replying to @{parse<any>(m.metadata, {}).replyTo.name}
                      {" · View quoted message"}
                    </summary>
                    <RichText
                      content={parse<any>(m.metadata, {}).replyTo.content}
                    />
                  </details>
                )}
                {showContent && <RichText content={m.content} />}
                <ActivityRecords
                  records={(
                    meta.activities || (meta.activity ? [meta.activity] : [])
                  ).filter(
                    (record: ActivityRecord) =>
                      conversationActivity(record) &&
                      !activities.some(
                        (a) =>
                          a.run === m.run_id &&
                          a.record.id === record.id &&
                          a.record.kind === record.kind &&
                          a.record.source.transport ===
                            record.source.transport &&
                          a.record.source.harness === record.source.harness,
                      ),
                  )}
                />
                <AttachmentList
                  files={parse<any>(m.metadata, {}).attachments || []}
                />
                {parse<any>(m.metadata, {}).steeringId && (
                  <p
                    className={
                      parse<any>(m.metadata, {}).delivery === "failed"
                        ? "error"
                        : "field-hint"
                    }
                    role="status"
                  >
                    {parse<any>(m.metadata, {}).delivery === "failed"
                      ? parse<any>(m.metadata, {}).deliveryError
                      : parse<any>(m.metadata, {}).delivery === "delivered"
                        ? "Sent to the active run"
                        : "Sending to the active run…"}
                  </p>
                )}
                {m.role === "assistant" &&
                  m.run_id &&
                  !meta.progress &&
                  !pendingAnswer && <MemoryUsed runId={m.run_id} />}
                {m.run_id &&
                  !parse<any>(m.metadata, {}).progress &&
                  (
                    data.messages
                      .filter(
                        (other) =>
                          other.run_id === m.run_id &&
                          other.role === "assistant" &&
                          !parse<any>(other.metadata, {}).progress,
                      )
                      .at(-1) ||
                    data.messages.find(
                      (other) =>
                        other.run_id === m.run_id &&
                        !parse<any>(other.metadata, {}).progress,
                    )
                  )?.id === m.id && (
                    <>
                      <ActivityRecords
                        records={activities
                          .filter((a) => a.run === m.run_id)
                          .map((a) => a.record)}
                      />
                      <RunStatus
                        state={m.run_state}
                        error={m.run_error}
                        empty={
                          m.role === "assistant"
                            ? !m.content ||
                              parse<any>(m.metadata, {}).partial === true
                            : true
                        }
                      />
                      {m.run_state === "awaiting_approval" && (
                        <Approvals
                          runId={m.run_id}
                          revision={0}
                          onChange={() => {
                            onSubmitted();
                            void load();
                          }}
                          onConversation={() => {}}
                        />
                      )}
                      {["failed", "interrupted"].includes(
                        m.run_state || "",
                      ) && (
                        <button
                          className="text-button"
                          disabled={!!retrying}
                          onClick={async () => {
                            if (retryBusy.current) return;
                            retryBusy.current = true;
                            setRetrying(m.run_id);
                            const key =
                              retryKeys.current.get(m.run_id!) ||
                              crypto.randomUUID();
                            retryKeys.current.set(m.run_id!, key);
                            try {
                              await api(`/runs/${m.run_id}/retry`, {
                                idempotencyKey: key,
                              });
                              onSubmitted();
                              await load();
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              retryBusy.current = false;
                              setRetrying(null);
                            }
                          }}
                        >
                          {retrying === m.run_id
                            ? "Queuing retry…"
                            : "Retry as a new run"}
                        </button>
                      )}
                    </>
                  )}
                {!parse<any>(m.metadata, {}).progress &&
                  m.role === "assistant" && (
                    <RunFiles
                      runId={m.run_id}
                      active={m.run_state === "running"}
                    />
                  )}
                {m.role === "assistant" &&
                  agent &&
                  !imported &&
                  !pendingAnswer && (
                    <button
                      className="text-button"
                      onClick={() =>
                        onReply({
                          agentId: agent.id,
                          conversationId: id,
                          messageId: m.id,
                          content: m.content,
                        })
                      }
                    >
                      <Reply size={16} /> Reply
                    </button>
                  )}
                {!meta.progress && !pendingAnswer && (
                  <div className="message-actions">
                    <button
                      aria-label="Copy message"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(m.content);
                          setNotice("Message copied.");
                        } catch {
                          setError(
                            "Could not copy. Select the message text and copy it.",
                          );
                        }
                      }}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      onClick={() => {
                        onUsePrompt(m.content);
                      }}
                    >
                      Edit as prompt
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await api("/artifacts", {
                            title: "Saved prompt: " + m.content.slice(0, 65),
                            content: m.content,
                            kind: "markdown",
                          });
                          onSubmitted();
                          setNotice("Prompt saved to your files.");
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Save as prompt
                    </button>
                    <a href={`/?conversation=${id}&message=${m.id}`}>Link</a>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {awayFromLatest && (
          <button
            className="text-button conversation-latest"
            aria-label="Jump to latest messages"
            onClick={() => {
              anchoring.current = false;
              followLatest.current = true;
              setAwayFromLatest(false);
              pinLatest();
            }}
          >
            <ArrowDown size={16} aria-hidden="true" /> Latest messages
          </button>
        )}
      </div>
      {transfer && (
        <Sheet
          title="Continue with another agent"
          onClose={() => {
            setTransfer(false);
            setError("");
          }}
        >
          <div className="transfer-panel">
            <label>
              Continue with
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value="">Choose a connected agent</option>
                {agents
                  .filter((a) => a.connection_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      @{a.name} · {a.provider} · {a.model}
                    </option>
                  ))}
              </select>
            </label>
            <fieldset className="transfer-messages">
              <legend>Messages to include</legend>
              {data?.messages
                .filter(
                  (m) => m.content && !parse<any>(m.metadata, {}).progress,
                )
                .map((m) => (
                  <label className="checkbox-row" key={m.id}>
                    <input
                      type="checkbox"
                      checked={included.includes(m.id)}
                      onChange={(e) =>
                        setIncluded((old) =>
                          e.target.checked
                            ? [...old, m.id]
                            : old.filter((id) => id !== m.id),
                        )
                      }
                    />
                    <span>
                      {m.role === "user" ? "You" : "Agent"}:{" "}
                      {m.content.slice(0, 180)}
                    </span>
                  </label>
                ))}
            </fieldset>
            <p className="note">
              Only the {included.length} selected messages will be copied. They
              will be sent to the selected provider when you send your next
              prompt. Other archive conversations stay private.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button
              className="primary"
              disabled={busy || !destination || !included.length}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  const r = await api(`/conversations/${id}/continue`, {
                    agentId: destination,
                    messageIds: included,
                  });
                  setTransfer(false);
                  onContinue(r.id);
                  onSubmitted();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create continuation
            </button>
          </div>
        </Sheet>
      )}
      {!editingModel && !transfer && (error || notice) && (
        <div className="conversation-feedback">
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : (
            <p role="status">{notice}</p>
          )}
          <button
            className="text-button"
            aria-label="Dismiss message"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <NativeDecisions conversation={id} />
      {!imported && agent && (
        <div className="conversation-composer">{composer}</div>
      )}
    </Sheet>
  );
}
