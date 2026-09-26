import { useEffect, useState } from "react";
import { api } from "./api";
import { Empty, RichText } from "./components";

type AgentMessage = {
  id: string;
  content: string;
  created_at: number;
  conversation_id: string;
  final: number | boolean;
};

export function AgentMessages({ agentId, revision, onConversation }: {
  agentId: string;
  revision: number;
  onConversation: (id: string) => void;
}) {
  const [items, setItems] = useState<AgentMessage[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<{ items: AgentMessage[] }>(`/agents/${agentId}/messages`)
      .then((page) => { if (active) { setItems(page.items); setError(""); } })
      .catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [agentId, revision]);
  return <section className="feed" aria-label="Agent messages">
    {error && <p role="alert">{error}</p>}
    {!items.length && !error && <Empty title="No agent messages yet.">{null}</Empty>}
    {items.map((item) => <article className="feed-card" key={item.id}>
      <span className="eyebrow">{item.final ? "Final response" : "Agent message"}</span>
      <time className="field-hint">{new Date(item.created_at).toLocaleString()}</time>
      <RichText content={item.content} />
      <button className="text-button" onClick={() => onConversation(item.conversation_id)}>
        Open conversation
      </button>
    </article>)}
  </section>;
}
