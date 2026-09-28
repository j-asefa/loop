import React from "react";
import { createRoot } from "react-dom/client";
import { Conversation } from "../../../src/client/Conversation";
import { NativeHistory } from "../../../src/client/NativeHistory";
import { loadCapabilities } from "../../../src/client/capabilities";
import "../../../src/client/style.css";
const noop = () => {};
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
  location.search.includes("history") ? (
    <NativeHistory
      onClose={noop}
      onOpen={(id) => {
        location.href = `/activity-integration?conversation=${id}&agent=${agent.id}`;
      }}
    />
  ) : (
    <Conversation
      id={
        new URLSearchParams(location.search).get("conversation") ||
        "conversation"
      }
      agents={[agent]}
      connections={[]}
      teams={[]}
      onClose={noop}
      onContinue={noop}
      onSent={noop}
      onSubmitted={noop}
      onProfile={noop}
      onNewConversation={noop}
    />
  ),
);
