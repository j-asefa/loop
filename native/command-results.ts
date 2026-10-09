// Pure native protocol correlation.
// Commands come from invocation input, never a tool title or result prose.
export type CompletedCommand = { id: string; command: string; output: string };
export function commandInput(input: any): string | undefined {
  return typeof input?.command === "string" ? input.command : undefined;
}
function outputText(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.filter(
      (part) => part?.type === "text" && typeof part.text === "string",
    );
    return parts.length ? parts.map((part) => part.text).join("\n") : undefined;
  }
  if (value && typeof value === "object") {
    if (
      value.isError ||
      value.is_error ||
      value.truncated ||
      value.metadata?.truncated ||
      value.details?.truncation?.truncated === true
    )
      return undefined;
    const exit =
      value.exitCode ??
      value.exit_code ??
      value.details?.exitCode ??
      value.metadata?.exit;
    if (exit !== undefined && exit !== 0) return undefined;
    return outputText(value.content ?? value.output ?? value.stdout);
  }
  return undefined;
}
export function commandResults() {
  const commands = new Map<string, string>();
  const start = (
    id: unknown,
    name: unknown,
    input: unknown,
    kind?: unknown,
  ) => {
    if (
      typeof id !== "string" ||
      (!["Bash", "bash", "shell", "exec_command"].includes(String(name)) &&
        kind !== "execute")
    )
      return;
    const command = commandInput(input);
    // Only PR creation results belong in the extra watch-registration envelope.
    // This permissive prefilter keeps wrappers; the server validates syntax.
    if (
      command &&
      command.length <= 4000 &&
      /\bgh\s+pr\s+create(?:\s|$)/.test(command) &&
      commands.size < 1000
    )
      commands.set(id, command);
  };
  const end = (
    id: unknown,
    output: unknown,
    success: boolean,
  ): CompletedCommand[] => {
    if (typeof id !== "string") return [];
    const command = commands.get(id);
    commands.delete(id);
    const text = success ? outputText(output) : undefined;
    if (
      !command ||
      text === undefined ||
      text.length > 64000 ||
      /\[hapi: truncated \d+ chars\]/.test(text)
    )
      return [];
    return [{ id, command, output: text }];
  };
  return {
    clear: () => commands.clear(),
    claude(message: any) {
      const results: CompletedCommand[] = [];
      if (
        message?.parent_tool_use_id ||
        !["assistant", "user"].includes(message?.type)
      )
        return results;
      for (const block of Array.isArray(message.message?.content)
        ? message.message.content
        : []) {
        if (block.type === "tool_use") start(block.id, block.name, block.input);
        if (block.type === "tool_result")
          results.push(
            ...end(block.tool_use_id, block.content, block.is_error !== true),
          );
      }
      return results;
    },
    pi(event: any) {
      if (event?.type === "tool_execution_start")
        start(event.toolCallId, event.toolName, event.args);
      return event?.type === "tool_execution_end"
        ? end(event.toolCallId, event.result, event.isError !== true)
        : [];
    },
    acp(message: any) {
      if (message?.type === "tool_call")
        start(message.id, message.name, message.input, message.kind);
      return message?.type === "tool_result"
        ? end(message.id, message.output, message.status === "completed")
        : [];
    },
  };
}
