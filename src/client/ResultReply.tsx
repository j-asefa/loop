import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import type { Agent, Artifact } from "../shared/types";
import { api, parse } from "./api";

export function ResultReply({
  item,
  agent,
  onSent,
  replyToMessageId,
}: {
  item: Pick<Artifact, "id" | "conversation_id">;
  agent: Agent;
  onSent: () => void;
  replyToMessageId?: string;
}) {
  const storageKey = replyToMessageId
    ? "loop-message-reply-" + replyToMessageId
    : "loop-result-reply-" + item.id;
  const [draft, setDraft] = useState(
    () => sessionStorage.getItem(storageKey) || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const receipt = useRef(
    parse<{ signature: string; key: string }>(
      sessionStorage.getItem(storageKey + "-receipt") || "",
      { signature: "", key: "" },
    ),
  );
  async function send() {
    if (lock.current || !draft.trim() || !item.conversation_id) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify(
      replyToMessageId
        ? [agent.id, item.conversation_id, draft, replyToMessageId]
        : [agent.id, item.conversation_id, draft],
    );
    if (receipt.current.signature !== signature)
      receipt.current = { signature, key: crypto.randomUUID() };
    sessionStorage.setItem(
      storageKey + "-receipt",
      JSON.stringify(receipt.current),
    );
    try {
      await api("/runs", {
        agentId: agent.id,
        conversationId: item.conversation_id,
        input: draft,
        replyToMessageId,
        idempotencyKey: receipt.current.key,
      });
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(storageKey + "-receipt");
      setDraft("");
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="result-reply">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="reply-box"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Reply to agent"
          placeholder={`Reply to @${agent.name}…`}
          rows={2}
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
            sessionStorage.setItem(storageKey, event.target.value);
          }}
        />
        <button
          className="primary icon-button"
          aria-label="Send reply"
          disabled={busy || !draft.trim()}
        >
          <ArrowUp size={20} />
        </button>
      </form>
    </div>
  );
}
