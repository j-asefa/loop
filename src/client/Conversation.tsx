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
import { AttachmentList, UploadButton, useAttachments } from "./Attachments";
import { MAX_MESSAGE_FILES } from "../shared/uploads";
import { NativeDecisions } from "./NativeControls";
import { Approvals } from "./Approvals";
import { HarnessPicker } from "./HarnessPicker";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Copy, MoreHorizontal } from "lucide-react";
import { api, parse } from "./api";
import { Sheet, RichText, Badge, Avatar } from "./components";
import type { Agent, Connection, Message, Team } from "../shared/types";
import { RunStatus } from "./RunStatus";
import { NativeConversation, MemoryUsed } from "./Memory";
export function Conversation({
  id,
  messageId,
  agents,
  connections,
  teams,
  onClose,
  onContinue,
  onSent,
  onSubmitted,
  onProfile,
  onAgentChanged,
  onNewConversation,
}: {
  id: string;
  messageId?: string | null;
  agents: Agent[];
  connections: Connection[];
  teams: Team[];
  onClose: () => void;
  onContinue: (id: string) => void;
  onSent: () => void;
  onSubmitted: () => void;
  onProfile: (agent: Agent) => void;
  onAgentChanged?: () => void;
  onNewConversation: (agent: Agent) => void;
}) {
  const activityItems = useConversationActivities(id);
  const activities = visibleActivities(activityItems);
  const [data, setData] = useState<{
      conversation: any;
      messages: ConversationMessage[];
      next: string | null;
    } | null>(null),
    [draft, setDraft] = useState(
      sessionStorage.getItem("loop-conversation-" + id) || "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [transfer, setTransfer] = useState(false),
    [destination, setDestination] = useState(""),
    [included, setIncluded] = useState<string[]>([]),
    [editingModel, setEditingModel] = useState(false);
  const [newProvider, setNewProvider] = useState<Agent | null>(null);
  const request = useRef(
      parse<{ signature: string; key: string }>(
        sessionStorage.getItem("loop-receipt-" + id) || "",
        { signature: "", key: "" },
      ),
    ),
    anchor = messageId;
  const generation = useRef(0);
  const scrolled = useRef("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const initialScroll = useRef<string | null>(null);
  const retryKeys = useRef(new Map<string, string>());
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryBusy = useRef(false);
  const [attachments, setAttachments] = useAttachments(
    "loop-conversation-files-" + id,
  );
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [uploading, setUploading] = useState(false);
  const paging = useRef(false);
  const loadRequest = useRef(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const agent = agents.find((a) => a.id === data?.conversation.agent_id),
    imported = data?.conversation.origin.endsWith("-import");
  async function load(initial = false) {
    if (paging.current) return;
    const current = generation.current;
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
    }
  }
  useEffect(() => {
    generation.current++;
    scrolled.current = "";
    setData(null);
    setDraft(sessionStorage.getItem("loop-conversation-" + id) || "");
    setTransfer(false);
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
    sessionStorage.setItem("loop-conversation-" + id, draft);
  }, [draft, id]);
  useLayoutEffect(() => {
    if (data?.conversation.id !== id || anchor || initialScroll.current === id)
      return;
    const messages = messagesRef.current;
    if (!messages) return;
    messages.scrollTop = messages.scrollHeight;
    initialScroll.current = id;
  }, [data, id, anchor]);
  useEffect(() => {
    if (!anchor || !data || scrolled.current === anchor) return;
    const frame = requestAnimationFrame(() => {
      const message = document.getElementById("message-" + anchor);
      if (message) {
        message.scrollIntoView({ block: "center" });
        message.focus({ preventScroll: true });
        scrolled.current = anchor;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [data, id, anchor]);
  async function send() {
    if (busy || uploading || !draft.trim() || !agent) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const targetConversation = id;
      const signature = JSON.stringify([
        targetConversation,
        agent.id,
        draft,
        attachments.map((file) => file.id),
      ]);
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      sessionStorage.setItem(
        "loop-receipt-" + id,
        JSON.stringify(request.current),
      );
      await api("/runs", {
        agentId: agent.id,
        conversationId: targetConversation,
        input: draft,
        idempotencyKey: request.current.key,
        attachmentIds: attachments.map((file) => file.id),
      });
      // Clear persisted text before closing unmounts this conversation.
      sessionStorage.removeItem("loop-conversation-" + id);
      setDraft("");
      setAttachments([]);
      request.current = { signature: "", key: "" };
      sessionStorage.removeItem("loop-receipt-" + id);
      document.getElementById("conversation-reply")?.blur();
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
                <Badge provider={agent.provider} />
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
      <div className="messages" ref={messagesRef} aria-busy={loading}>
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
        {data?.messages.map((m) => (
          <article
            key={m.id}
            id={"message-" + m.id}
            tabIndex={-1}
            className={
              "message " +
              m.role +
              (parse<any>(m.metadata, {}).progress ? " agent-progress" : "") +
              (anchor === m.id ? " anchored" : "")
            }
          >
            <span className="eyebrow">
              {m.role === "user" ? "You" : `@${agent?.name || "agent"}`}
              {parse<any>(m.metadata, {}).progress ? " · Update" : ""}
              {parse<any>(m.metadata, {}).activeBranch === false
                ? " · alternate branch"
                : ""}
            </span>
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
            {m.content && parse<any>(m.metadata, {}).partial !== true && (
              <RichText content={m.content} />
            )}
            <ActivityRecords
              records={(
                parse<any>(m.metadata, {}).activities ||
                (parse<any>(m.metadata, {}).activity
                  ? [parse<any>(m.metadata, {}).activity]
                  : [])
              ).filter(
                (record: ActivityRecord) =>
                  !activities.some(
                    (a) =>
                      a.run === m.run_id &&
                      a.record.id === record.id &&
                      a.record.kind === record.kind &&
                      a.record.source.transport === record.source.transport &&
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
            {m.role === "assistant" && m.run_id && (
              <MemoryUsed runId={m.run_id} />
            )}
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
                  {["failed", "interrupted"].includes(m.run_state || "") && (
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
            {!parse<any>(m.metadata, {}).progress && (
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
                    setDraft(m.content);
                    document.getElementById("conversation-reply")?.focus();
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
        ))}
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
      {!imported && (
        <div className="conversation-composer">
          <AttachmentList
            files={attachments}
            onRemove={(id) =>
              setAttachments(attachments.filter((file) => file.id !== id))
            }
          />
          <div className="conversation-composer-controls">
            <UploadButton
              menu
              folderId={agent?.folder_id}
              agentId={agent?.id}
              disabled={busy}
              remaining={MAX_MESSAGE_FILES - attachments.length}
              onBusy={setUploading}
              onUploaded={(file) => {
                attachmentsRef.current = [...attachmentsRef.current, file];
                setAttachments(attachmentsRef.current);
              }}
            />
            <HarnessPicker
              agentId={agent?.id}
              conversationId={id}
              value={draft}
              onChange={setDraft}
              focusInput={() =>
                document.getElementById("conversation-reply")?.focus()
              }
            />
          </div>
          <form
            className="reply-box"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              id="conversation-reply"
              aria-label="Reply to agent"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Continue with @${agent?.name || "agent"}…`}
              rows={1}
            />
            <button
              className="primary icon-button"
              disabled={!draft.trim() || busy || uploading || !agent}
              aria-label="Send reply"
            >
              <ArrowUp size={20} />
            </button>
          </form>
        </div>
      )}
    </Sheet>
  );
}
