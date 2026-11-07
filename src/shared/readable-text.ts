export type DisplayAgent = { id: string; name: string };

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const opaque = `(?:${uuid}|[0-9a-f]{32,64})`;

/** Display only. Never use this to rewrite records, citations or navigation IDs. */
export function readableText(value: string): string {
  return value
    .replace(
      /data:[^\s,;]+(?:;[^,\s]*)?;base64,[a-z0-9+/=_-]+/gi,
      "[attached file]",
    )
    .replace(
      /(?<![a-z0-9+/_=-])(?:[a-z0-9+/_-]{48,}={0,2}\r?\n)+[a-z0-9+/_-]{16,}={0,2}/gi,
      "[encoded content omitted]",
    )
    .replace(
      /(?<![\w./-])(?:[\w./-]*\/)?\.git\/loop-agent-worktrees\/[^\s`"'<>]+/gi,
      "the agent’s workspace",
    )
    .replace(/loop\/agent-[a-f0-9]{4,64}\b/gi, "the agent’s branch")
    .replace(/[a-z0-9+/_=-]{80,}/gi, "[encoded content omitted]")
    .replace(
      new RegExp(
        `\\b(?:agent|sender|recipient)\\s+[\x60"']?@?${opaque}[\x60"']?`,
        "gi",
      ),
      "an agent",
    )
    .replace(
      new RegExp(
        `\\b(?:thread|conversation)\\s+[\x60"']?${opaque}[\x60"']?`,
        "gi",
      ),
      "the conversation",
    )
    .replace(
      new RegExp(`\\b(?:snapshot|review)\\s+[\x60"']?${opaque}[\x60"']?`, "gi"),
      "the saved review",
    )
    .replace(
      new RegExp(
        `\\b(?:res|msg|saved|approval|chk|ver|st|dec|q|un)_${opaque}\\b`,
        "gi",
      ),
      "the source record",
    )
    .replace(new RegExp(`[\x60]?@?${uuid}[\x60]?`, "gi"), "a referenced item")
    .replace(/\b[0-9a-f]{32,64}\b/gi, "a reference")
    .replace(
      /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{8,40}\b/gi,
      "the revision",
    );
}

export function readableAuthor(
  value: string,
  agents: readonly DisplayAgent[] = [],
): string {
  if (value === "you" || value === "owner") return "you";
  const agent = agents.find((a) => a.id === value.replace(/^@/, ""));
  const name = agent?.name ?? value;
  if (!name.trim() || readableText(name) !== name) return "an agent";
  return agent ? "@" + name.replace(/^@/, "") : name;
}
