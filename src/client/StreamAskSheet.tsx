import { useMemo, useState } from "react";
import { PencilLine, Sparkles, Zap } from "lucide-react";
import { defaultStreamAskPrompt, type StreamItem } from "../shared/stream-item";
import {
  buildStreamActionPrompt,
  DEFAULT_STREAM_ACTIONS,
  snippetLabel,
} from "../shared/workshop-actions";
import type { EnvironmentAgent } from "./agentSources";
import { AgentPicker } from "./AgentPicker";
import { Sheet } from "./components";
import { useSnippets } from "./useSnippets";

/**
 * Compact one-tap quick-action sheet for turning a StreamItem (RSS today, Email
 * later) into an agent prompt using built-in actions, the user's saved `/`
 * snippets, or a custom prompt. Always hands off to Loop's composer so drafts
 * and explicit sends stay safe.
 */
export function StreamAskSheet({
  item,
  agents,
  onClose,
  onAsk,
}: {
  item: StreamItem;
  agents: EnvironmentAgent[];
  onClose: () => void;
  onAsk: (text: string, agentId?: string) => void;
}) {
  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.retired_at && !agent.sourceId),
    [agents],
  );
  const councilAgent = useMemo(
    () => activeAgents.find((agent) => /council/i.test(agent.name)),
    [activeAgents],
  );
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const resolvedAgent = activeAgents.some((agent) => agent.id === selectedAgent)
    ? selectedAgent
    : "";
  const { snippets } = useSnippets(true);

  const choose = (instruction: string, preferCouncil = false) => {
    // Only override the composer's current recipient when the user explicitly
    // picked an agent here, or chose "Ask LLM council" and a council agent exists.
    const target =
      resolvedAgent || (preferCouncil ? councilAgent?.id : undefined);
    const prompt = buildStreamActionPrompt(item, instruction);
    onClose();
    onAsk(prompt, target);
  };

  const custom = () => {
    const prompt = defaultStreamAskPrompt(item);
    onClose();
    onAsk(prompt, resolvedAgent || undefined);
  };

  return (
    <Sheet
      title="Ask an agent"
      onClose={onClose}
      className="action-sheet stream-ask-sheet"
    >
      <p className="later-target">
        <strong>{item.title}</strong>
        <small>{item.sourceLabel}</small>
      </p>

      {activeAgents.length > 0 && (
        <div className="stream-ask-agent">
          <AgentPicker
            label="Choose agent"
            title="Send to agent"
            value={resolvedAgent}
            extras={[{ value: "", label: "Current composer agent" }]}
            onChange={setSelectedAgent}
            agents={activeAgents.map((agent) => ({
              value: agent.id,
              name: agent.name,
            }))}
          />
        </div>
      )}

      <div className="action-list">
        {DEFAULT_STREAM_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => choose(action.instruction, action.preferCouncil)}
          >
            <Zap size={18} aria-hidden="true" />
            <span>
              <strong>{action.label}</strong>
              <small>{action.hint}</small>
            </span>
          </button>
        ))}

        {snippets.length > 0 && (
          <>
            <p className="field-hint stream-ask-section">Your / snippets</p>
            {snippets.map((snippet) => (
              <button
                key={snippet.id}
                type="button"
                onClick={() => choose(snippet.content)}
              >
                <Sparkles size={18} aria-hidden="true" />
                <span>
                  <strong>
                    {snippetLabel(snippet.title, snippet.content)}
                  </strong>
                  <small>{snippet.content.slice(0, 90)}</small>
                </span>
              </button>
            ))}
          </>
        )}

        <button type="button" onClick={custom}>
          <PencilLine size={18} aria-hidden="true" />
          <span>
            <strong>Write custom prompt…</strong>
            <small>Open composer with this item attached.</small>
          </span>
        </button>
      </div>
    </Sheet>
  );
}
