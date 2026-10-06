import React from "react";
import { createRoot } from "react-dom/client";
import { Traces } from "../../../src/client/Traces";
import { Conversation } from "../../../src/client/Conversation";
import { NativeHistory } from "../../../src/client/NativeHistory";
import { HarnessPicker } from "../../../src/client/HarnessPicker";
import { loadCapabilities } from "../../../src/client/capabilities";
import "../../../src/client/style.css";
const noop = () => {};
const conversationId =
  new URLSearchParams(location.search).get("conversation") || "conversation";
await loadCapabilities();
const agent: any = {
  id: new URLSearchParams(location.search).get("agent") || "agent",
  name: "Fixture",
  provider: "codex",
  model: "a",
  connection_id: "native",
  metadata: "{}",
};
createRoot(document.getElementById("root")!).render(
  location.search.includes("traces") ? (
    <Traces
      agentId={agent.id}
      revision={0}
      onConversation={noop}
      onArtifact={noop}
    />
  ) : location.search.includes("history") ? (
    <NativeHistory
      onClose={noop}
      onOpen={(id) => {
        location.href = `/activity-integration?conversation=${id}&agent=${agent.id}`;
      }}
    />
  ) : (
    <Conversation
      id={conversationId}
      agents={[agent]}
      revision={0}
      connections={[]}
      teams={[]}
      onClose={noop}
      onContinue={noop}
      composer={
        <HarnessPicker
          agentId={agent.id}
          conversationId={conversationId}
          value=""
          onChange={noop}
          focusInput={noop}
        />
      }
      onReady={noop}
      onReply={noop}
      onUsePrompt={noop}
      onRestoreDraft={noop}
      onWithdraw={async () => {}}
      onSubmitted={noop}
      onProfile={noop}
      onNewConversation={noop}
    />
  ),
);
