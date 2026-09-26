import { NativeDecisions } from "./NativeControls";
import { HarnessPicker } from "./HarnessPicker";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Copy, Play } from "lucide-react";
import { api, parse } from "./api";
import { Sheet, RichText, Badge } from "./components";
import type { Agent, Connection, Message, Team } from "../shared/types";
import { RunStatus } from "./RunStatus";
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
  onError,
  onProfile,
  onAgentChanged,
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
  onError: (s: string) => void;
  onProfile: (agent: Agent) => void;
  onAgentChanged?: () => void;
}) {
  const [data, setData] = useState<{
      conversation: any;
      messages: Message[];
      next: number | null;
    } | null>(null),
    [draft, setDraft] = useState(
      sessionStorage.getItem("loop-conversation-" + id) || "",
    ),
    [busy, setBusy] = useState(false),
    [transfer, setTransfer] = useState(false),
    [destination, setDestination] = useState(""),
    [included, setIncluded] = useState<string[]>([]),
    [editingModel, setEditingModel] = useState(false);
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
  const agent = agents.find((a) => a.id === data?.conversation.agent_id),
    imported = data?.conversation.origin.endsWith("-import");
  async function load(initial = false) {
    const current = generation.current;
    try {
      const fresh = await api(
        "/conversations/" +
          id +
          (initial && anchor ? "?message=" + anchor : ""),
      );
      if (current !== generation.current) return;
      setData((old) =>
        !initial && old
          ? {
              ...fresh,
              messages: [
                ...new Map(
                  [...old.messages, ...fresh.messages].map((m) => [m.id, m]),
                ).values(),
              ].sort((a, b) => (a as any).cursor - (b as any).cursor),
              next: old.next,
            }
          : fresh,
      );
      if (initial)
        setIncluded(
          fresh.messages
            .filter(
              (m: Message) => parse<any>(m.metadata, {}).activeBranch !== false,
            )
            .map((m: Message) => m.id),
        );
    } catch (e) {
      onError((e as Error).message);
    }
  }
  useEffect(() => {
    generation.current++;
    scrolled.current = "";
    setData(null);
    setDraft(sessionStorage.getItem("loop-conversation-" + id) || "");
    setTransfer(false);
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
    if (busy || !draft.trim() || !agent) return;
    setBusy(true);
    try {
      const targetConversation = id;
      const signature = JSON.stringify([targetConversation, agent.id, draft]);
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
      });
      // Clear persisted text before closing unmounts this conversation.
      sessionStorage.removeItem("loop-conversation-" + id);
      setDraft("");
      request.current = { signature: "", key: "" };
      sessionStorage.removeItem("loop-receipt-" + id);
      document.getElementById("conversation-reply")?.blur();
      onSent();
    } catch (e) {
      onError((e as Error).message);
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
        <Badge provider={agent?.provider} />
        <button
          className="text-button"
          disabled={!agent}
          onClick={() => agent && onProfile(agent)}
        >
          @{agent?.name} · {agent?.model}
        </button>
        {agent && (
          <button
            className="text-button"
            onClick={() => setEditingModel(!editingModel)}
          >
            Change model
          </button>
        )}
      </div>
      {editingModel && agent && (
        <form
          className="conversation-model-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const model = String(new FormData(e.currentTarget).get("model"));
              const effort =
                new FormData(e.currentTarget).get("effort") || null;
              await api(`/agents/${agent.id}`, { model, effort }, "PATCH");
              onAgentChanged?.();
              setEditingModel(false);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          <label>
            Model for next message
            <select name="model" defaultValue={agent.model}>
              {parse<{ id: string; name: string }[]>(
                connections.find((c) => c.id === agent.connection_id)?.models,
                [],
              ).map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {(agent.provider === "openai" || agent.provider === "codex") && (
            <label>
              Reasoning effort
              <select name="effort" defaultValue={agent.effort || ""}>
                <option value="">Provider default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
          )}
          <button className="primary">Save model</button>
        </form>
      )}
      <div className="messages" ref={messagesRef}>
        {data?.next && (
          <button
            className="text-button"
            onClick={async () => {
              const older = await api(
                "/conversations/" + id + "?before=" + data.next,
              );
              setData({
                ...data,
                messages: [...older.messages, ...data.messages],
                next: older.next,
              });
            }}
          >
            Load earlier messages
          </button>
        )}
        {data?.messages.map((m) => (
          <article
            key={m.id}
            id={"message-" + m.id}
            tabIndex={-1}
            className={
              "message " + m.role + (anchor === m.id ? " anchored" : "")
            }
          >
            <span className="eyebrow">
              {m.role === "user" ? "You" : `@${agent?.name || "agent"}`}
              {parse<any>(m.metadata, {}).activeBranch === false
                ? " · alternate branch"
                : ""}
            </span>
            {transfer && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={included.includes(m.id)}
                  onChange={(e) =>
                    setIncluded((old) =>
                      e.target.checked
                        ? [...old, m.id]
                        : old.filter((x) => x !== m.id),
                    )
                  }
                />
                Include this message
              </label>
            )}
            {m.content && <RichText content={m.content} />}
            {m.run_id &&
              (m.role === "assistant" ||
                !data.messages.some(
                  (other) =>
                    other.run_id === m.run_id && other.role === "assistant",
                )) && (
                <>
                  <RunStatus
                    state={m.run_state}
                    error={m.run_error}
                    empty={m.role === "assistant" ? !m.content : true}
                  />
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
                          onError((e as Error).message);
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
            <div className="message-actions">
              <button
                aria-label="Copy message"
                onClick={() => navigator.clipboard.writeText(m.content)}
              >
                <Copy size={14} />
              </button>
              <button onClick={() => setDraft(m.content)}>
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
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
              >
                Save as prompt
              </button>
              <a href={`/?conversation=${id}&message=${m.id}`}>Link</a>
            </div>
          </article>
        ))}
      </div>
      <div className="conversation-secondary-actions">
        <button
          className="text-button"
          aria-expanded={transfer}
          onClick={() => setTransfer(!transfer)}
        >
          Continue with another agent
        </button>
      </div>
      {transfer && (
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
          <p className="note">
            Only the {included.length} selected messages below will be copied.
            They will be sent to the selected provider when you send your next
            prompt. Other archive conversations stay private.
          </p>
          <button
            className="primary"
            disabled={!destination || !included.length}
            onClick={async () => {
              try {
                const r = await api(`/conversations/${id}/continue`, {
                  agentId: destination,
                  messageIds: included,
                });
                onContinue(r.id);
                onSubmitted();
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            Create continuation
          </button>
        </div>
      )}
      <NativeDecisions conversation={id} />
      {!imported && (
        <div className="conversation-composer">
          <HarnessPicker
            agentId={agent?.id}
            conversationId={id}
            value={draft}
            onChange={setDraft}
            focusInput={() =>
              document.getElementById("conversation-reply")?.focus()
            }
          />
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
              disabled={!draft.trim() || busy || !agent}
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
