// Only public activity/transcript fields are exposed. Reasoning/thinking and
// provider control messages are deliberately not part of the user trace.
const text = (value) =>
  typeof value === "string" ? value.slice(0, 12000) : "";
export function codexTrace(message, messages = new Map()) {
  if (message.method === "item/agentMessage/delta") {
    const id = message.params?.itemId;
    if (!id || typeof message.params?.delta !== "string") return;
    const item = messages.get(id) || { id, type: "agentMessage", text: "" };
    item.text = (item.text + message.params.delta).slice(0, 200000);
    messages.set(id, item);
    return publicMessage(item);
  }
  if (!["item/started", "item/completed"].includes(message.method)) return;
  const item = message.params?.item;
  if (!item?.id) return;
  if (item.type === "agentMessage") {
    messages.set(item.id, { ...item, text: item.text || "" });
    return publicMessage(item);
  }
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
function publicMessage(item) {
  // Some older hosts omit phase. Loop's JSON answer envelope is never a
  // progress message; only the public text between native actions belongs here.
  if (
    item.phase === "final_answer" ||
    (!item.phase &&
      String(item.text || "")
        .trimStart()
        .startsWith("{"))
  )
    return;
  return {
    id: item.id,
    kind: "message",
    title: "Agent update",
    content: String(item.text || "").slice(0, 200000),
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
          content:
            typeof block.text === "string" ? block.text.slice(0, 200000) : "",
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
