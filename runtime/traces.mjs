// Only public activity/transcript fields are exposed. Reasoning/thinking and
// provider control messages are deliberately not part of the user trace.
const text = (value) =>
  typeof value === "string" ? value.slice(0, 12000) : "";
export function codexTrace(message) {
  if (!["item/started", "item/completed"].includes(message.method)) return;
  const item = message.params?.item;
  if (!item?.id) return;
  if (item.type === "agentMessage" && item.phase === "commentary")
    return {
      id: item.id,
      kind: "message",
      title: "Agent update",
      content: text(item.text),
    };
  const titles = {
    commandExecution: "Run command",
    fileChange: "Change files",
    mcpToolCall: "Use tool",
    dynamicToolCall: "Use tool",
    webSearch: "Search the web",
  };
  if (!titles[item.type]) return;
  return {
    id: item.id,
    kind: "tool",
    title: item.tool || titles[item.type],
    content: text(item.command || item.query || item.aggregatedOutput),
    state:
      message.method === "item/started"
        ? "running"
        : item.status || "completed",
  };
}
export function claudeTraces(message, internalToolIds = new Set()) {
  if (!["assistant", "user"].includes(message.type)) return [];
  return (
    Array.isArray(message.message?.content) ? message.message.content : []
  ).flatMap((block, index) => {
    // --json-schema uses this internal tool to deliver Loop's envelope. Its
    // acknowledgement is not an agent update or a successful external action.
    if (block.type === "tool_use" && block.name === "StructuredOutput") {
      internalToolIds.add(block.id);
      return [];
    }
    if (block.type === "tool_result" && internalToolIds.has(block.tool_use_id))
      return [];
    if (block.type === "text" && message.type === "assistant")
      return [
        {
          id: `${message.message.id || message.uuid}:text:${index}`,
          kind: "message",
          title: "Agent update",
          content: text(block.text),
        },
      ];
    if (block.type === "tool_use")
      return [
        {
          id: block.id,
          kind: "tool",
          title: block.name,
          content: text(JSON.stringify(block.input)),
          state: "running",
        },
      ];
    if (block.type === "tool_result")
      return [
        {
          id: block.tool_use_id + ":result",
          kind: "tool",
          title: "Tool result",
          content: text(
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content),
          ),
          state: block.is_error ? "failed" : "completed",
        },
      ];
    return [];
  });
}
