import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, MessagesSquare } from "lucide-react";
import type { Agent, Run, Team } from "../shared/types";
import { api } from "./api";
import { Sheet } from "./components";

type SavedConversation = {
  id: string;
  title: string;
  created_at: number;
  team_id?: string | null;
};

export function AgentConversations({
  agent,
  teams,
  onOpen,
}: {
  agent: Agent;
  teams: Team[];
  onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conversations, setConversations] = useState<
    SavedConversation[] | null
  >(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function open() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        conversations: SavedConversation[];
        runs: Run[];
      }>(`/agents/${agent.id}`);
      if (!active.current) return;
      // Include personal and team conversations, ordered by their latest work.
      const latest = (conversation: SavedConversation) =>
        Math.max(
          conversation.created_at,
          ...result.runs
            .filter((run) => run.conversation_id === conversation.id)
            .map((run) => run.updated_at),
        );
      const items = [...result.conversations].sort(
        (a, b) => latest(b) - latest(a),
      );
      if (items.length === 1) onOpen(items[0].id);
      else setConversations(items);
    } catch (error) {
      if (active.current) setError((error as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      <button className="secondary" disabled={busy} onClick={() => void open()}>
        <MessagesSquare size={16} />
        {busy ? "Opening…" : "Open conversation"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {conversations && (
        <Sheet
          title={`Conversations with @${agent.name}`}
          onClose={() => setConversations(null)}
        >
          {conversations.length ? (
            <div className="agent-conversations">
              <p className="field-hint">
                Recent conversations, including all team and personal work.
              </p>
              {conversations.map((conversation) => (
                <button
                  className="agent-conversation"
                  key={conversation.id}
                  onClick={() => {
                    setConversations(null);
                    onOpen(conversation.id);
                  }}
                >
                  <span>
                    <strong>{conversation.title || "Conversation"}</strong>
                    <small>
                      {teams.find((team) => team.id === conversation.team_id)
                        ?.name ||
                        (conversation.team_id
                          ? "Team conversation"
                          : "Direct conversation")}
                      {" · "}
                      {new Date(conversation.created_at).toLocaleDateString(
                        undefined,
                        { day: "numeric", month: "short" },
                      )}
                    </small>
                  </span>
                  <ArrowUpRight size={18} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <p>No conversations yet. Send a message to start one.</p>
          )}
        </Sheet>
      )}
    </>
  );
}
