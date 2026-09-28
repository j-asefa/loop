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

// Structured display data from the runtime's own executors (command output,
// file changes, harness plans). Traces above stay a bounded text summary; the
// server maps these through the shared direct extractors into activity
// records. Display only: nothing here applies a change or runs a command.
// Text keeps one character beyond the server's 48,000-character retention so
// the server can still mark the result as truncated.
const KEEP = 48_001;
const head = (value, n = KEEP) =>
  typeof value === "string" ? value.slice(0, n) : undefined;
const tail = (value, n = KEEP) =>
  typeof value === "string" ? value.slice(-n) : undefined;
// Whole-event budget, well inside the 2 MB NDJSON line limit.
const DIFF_BUDGET = 1_000_000;
export function codexActivity(message) {
  const params = message?.params;
  if (message?.method === "turn/plan/updated") {
    if (typeof params?.turnId !== "string" || !Array.isArray(params.plan))
      return;
    return {
      harness: "codex",
      method: message.method,
      params: {
        turnId: params.turnId,
        explanation: head(params.explanation, 4000),
        plan: params.plan.slice(0, 100).map((step) => ({
          step: head(step?.step, 2000),
          status: step?.status,
        })),
      },
    };
  }
  if (!["item/started", "item/completed"].includes(message?.method)) return;
  const item = params?.item;
  if (typeof item?.id !== "string") return;
  if (item.type === "commandExecution")
    return {
      harness: "codex",
      method: message.method,
      params: {
        item: {
          id: item.id,
          type: item.type,
          status: item.status,
          command: head(item.command, 4000),
          cwd: head(item.cwd, 4096),
          exitCode: Number.isInteger(item.exitCode) ? item.exitCode : undefined,
          aggregatedOutput: tail(item.aggregatedOutput),
        },
      },
    };
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    let budget = DIFF_BUDGET;
    return {
      harness: "codex",
      method: message.method,
      params: {
        item: {
          id: item.id,
          type: item.type,
          status: item.status,
          changes: item.changes.slice(0, 100).map((change) => {
            const diff = head(change?.diff);
            // Over budget, the diff is omitted and shown as unavailable.
            const keep = diff !== undefined && diff.length <= budget;
            if (keep) budget -= diff.length;
            return {
              path: head(change?.path, 4096),
              kind: change?.kind && {
                type: change.kind.type,
                move_path: head(
                  change.kind.move_path ?? change.kind.movePath,
                  4096,
                ),
              },
              ...(keep && { diff }),
            };
          }),
        },
      },
    };
  }
}
// Claude Code tool blocks that carry structured results: Bash output,
// Write/Edit file content and TodoWrite plans. The server correlates each
// tool_result with its tool_use; unrelated tools and their results are not
// forwarded. `pending` holds forwarded Bash/Write/Edit ids awaiting a result.
const CLAUDE_TOOLS = new Set(["Bash", "Write", "Edit", "TodoWrite"]);
export function claudeActivities(message, pending = new Set()) {
  if (!["assistant", "user"].includes(message?.type)) return [];
  const blocks = Array.isArray(message.message?.content)
    ? message.message.content
    : [];
  return blocks.flatMap((block) => {
    if (
      block?.type === "tool_use" &&
      typeof block.id === "string" &&
      CLAUDE_TOOLS.has(block.name)
    ) {
      const input = block.input || {};
      if (block.name !== "TodoWrite" && pending.size < 1000) pending.add(block.id);
      return [
        {
          harness: "claude",
          block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {
              command: head(input.command, 4000),
              file_path: head(input.file_path, 4096),
              content: head(input.content),
              old_string: head(input.old_string),
              new_string: head(input.new_string),
              todos: Array.isArray(input.todos)
                ? input.todos.slice(0, 100).map((todo) => ({
                    id: head(todo?.id, 300),
                    content: head(todo?.content, 2000),
                    status: todo?.status,
                  }))
                : undefined,
            },
          },
        },
      ];
    }
    if (
      block?.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      pending.delete(block.tool_use_id)
    ) {
      const content =
        typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .filter((part) => part?.type === "text")
                .map((part) => String(part.text ?? ""))
                .join("\n")
            : "";
      return [
        {
          harness: "claude",
          block: {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            is_error: block.is_error === true,
            content: tail(content),
          },
        },
      ];
    }
    return [];
  });
}
