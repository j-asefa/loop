import { useEffect, useRef, useState } from "react";
import { ArrowUp, Copy, Play } from "lucide-react";
import { api, parse } from "./api";
import { Sheet, RichText, Badge } from "./components";
import type { Agent, Message } from "../shared/types";
export function Conversation({
  id,
  agents,
  onClose,
  onContinue,
  onSubmitted,
  onError,
}: {
  id: string;
  agents: Agent[];
  onClose: () => void;
  onContinue: (id: string) => void;
  onSubmitted: () => void;
  onError: (s: string) => void;
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
    [included, setIncluded] = useState<string[]>([]);
  const request = useRef({ signature: "", key: "" }),
    anchor = new URLSearchParams(location.search).get("message");
  const agent = agents.find((a) => a.id === data?.conversation.agent_id),
    imported = data?.conversation.origin.endsWith("-import");
  async function load(initial = false) {
    try {
      const fresh = await api(
        "/conversations/" +
          id +
          (initial && anchor ? "?message=" + anchor : ""),
      );
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
    setData(null);
    setDraft(sessionStorage.getItem("loop-conversation-" + id) || "");
    setTransfer(false);
    void load(true);
    const timer = setInterval(() => void load(), 1800);
    return () => clearInterval(timer);
  }, [id]);
  useEffect(() => {
    sessionStorage.setItem("loop-conversation-" + id, draft);
  }, [draft, id]);
  useEffect(() => {
    if (anchor && data)
      document
        .getElementById("message-" + anchor)
        ?.scrollIntoView({ block: "center" });
  }, [!!data, id]);
  async function send() {
    if (!draft.trim() || !agent) return;
    setBusy(true);
    try {
      const signature = JSON.stringify([id, agent.id, draft]);
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      await api("/runs", {
        agentId: agent.id,
        conversationId: id,
        input: draft,
        idempotencyKey: request.current.key,
      });
      setDraft("");
      request.current = { signature: "", key: "" };
      onSubmitted();
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      wide
      title={data?.conversation.title || "Conversation"}
      onClose={onClose}
    >
      <div className="conversation-meta">
        <Badge provider={agent?.provider} />
        <span>
          @{agent?.name} · {agent?.model}
        </span>
      </div>
      {true && (
        <div className="note">
          {imported ? "Imported history. " : ""}Continue with selected messages
          in a new Loop conversation.
          <button
            className="text-button"
            onClick={() => setTransfer(!transfer)}
          >
            Continue in Loop
          </button>
        </div>
      )}
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
      <div className="messages">
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
            <RichText content={m.content || "Working…"} />
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
      {!imported && (
        <>
          <form
            className="reply-box"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`Continue with @${agent?.name || "agent"}…`}
              rows={2}
            />
            <button
              className="primary icon-button"
              disabled={!draft.trim() || busy || !agent}
              aria-label="Send reply"
            >
              <ArrowUp size={20} />
            </button>
          </form>
          <p className="field-hint">
            Replies use this conversation’s history and the agent’s current
            model.
          </p>
        </>
      )}
    </Sheet>
  );
}
