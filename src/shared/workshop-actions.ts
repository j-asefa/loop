import {
  defaultStreamAskPrompt,
  safeHttpUrl,
  type StreamItem,
} from "./stream-item.js";

export type WorkshopQuickAction = {
  id: string;
  label: string;
  hint: string;
  instruction: string;
  preferCouncil?: boolean;
};

export const DEFAULT_STREAM_ACTIONS: readonly WorkshopQuickAction[] = [
  {
    id: "summarize-critique",
    label: "Summarize & critique",
    hint: "Key takeaways, strongest counterarguments, and what matters.",
    instruction:
      "Summarize the key takeaways concisely, then critique the main claims and highlight the strongest counterargument.",
  },
  {
    id: "ask-council",
    label: "Ask LLM council",
    hint: "Evaluate from multiple perspectives and surface disagreements.",
    instruction:
      "Evaluate this from multiple perspectives, verify the key claims, and highlight the most important disagreements or caveats.",
    preferCouncil: true,
  },
  {
    id: "connect-project",
    label: "Connect to my project",
    hint: "Check how this relates to the current codebase or goals.",
    instruction:
      "Analyze how this relates to my current project and tell me whether anything here is worth applying or avoiding.",
  },
];

export const DEFAULT_DONE_QUICK_REPLIES: readonly WorkshopQuickAction[] = [
  {
    id: "challenge",
    label: "Challenge this",
    hint: "Stress-test assumptions and blind spots.",
    instruction:
      "Challenge the key assumptions in this answer and point out the strongest counterargument or blind spot.",
  },
  {
    id: "dig-deeper",
    label: "Dig deeper",
    hint: "Concrete examples, tradeoffs, and edge cases.",
    instruction:
      "Go deeper on the most important point here with concrete examples, tradeoffs, and edge cases.",
  },
  {
    id: "turn-into-task",
    label: "Turn into a task",
    hint: "Minimal implementation plan with acceptance criteria.",
    instruction:
      "Turn this into a concrete, minimal implementation plan with clear acceptance criteria.",
  },
];

const MAX_EXCERPT_CHARS = 1200;

/**
 * Assembles an attribution-preserving prompt combining a StreamItem (RSS today,
 * Email later) with a quick action or user / snippet instruction.
 */
export function buildStreamActionPrompt(
  item: StreamItem,
  instruction: string,
): string {
  const trimmed = instruction.trim();
  if (!trimmed) return defaultStreamAskPrompt(item);

  const ctx = item.agentPromptContext;
  const safeUrl = safeHttpUrl(ctx.url);
  const safeDiscussion = safeHttpUrl(ctx.discussionUrl);
  const lines = [
    ctx.kind === "email"
      ? `About this email from ${ctx.sourceLabel}: ${ctx.title}`
      : `About this ${ctx.sourceLabel} ${ctx.itemKindLabel}: ${ctx.title}`,
  ];
  if (safeUrl) lines.push(safeUrl);
  if (safeDiscussion && safeDiscussion !== safeUrl)
    lines.push(`Discussion: ${safeDiscussion}`);

  const excerpt = ctx.excerpt?.trim();
  if (excerpt) {
    const bounded =
      excerpt.length > MAX_EXCERPT_CHARS
        ? `${excerpt.slice(0, MAX_EXCERPT_CHARS).trimEnd()}…`
        : excerpt;
    lines.push("", `Excerpt: ${bounded}`);
  }

  lines.push("", trimmed);
  return lines.join("\n");
}

/**
 * Formats a concise single-line snippet title matching Loop's existing
 * "Save as snippet" convention.
 */
export function snippetTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const preview =
    normalized.length > 60 ? `${normalized.slice(0, 59)}…` : normalized;
  return `Snippet: ${preview || "Untitled"}`;
}

/**
 * Formats a clean label for a saved snippet entry in quick-action sheets.
 */
export function snippetLabel(title: string, content: string): string {
  const stripped = title.replace(/^Snippet:\s*/i, "").trim();
  if (stripped) return stripped;
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 60
    ? `${normalized.slice(0, 59)}…`
    : normalized || "Saved snippet";
}

/**
 * Determines whether ReplyButton / Quick reply inside Feed's Done reading sheet
 * should be active. Disabled while streaming/writing, on non-finished or
 * non-assistant cards, or when the card has no quotable reply target.
 */
export function canReplyFromDoneSheet(options: {
  isFinished: boolean;
  writing: boolean;
  hasReplyHandler: boolean;
  hasQuote?: boolean;
  isAssistant?: boolean;
}): boolean {
  return (
    options.isFinished &&
    !options.writing &&
    options.hasReplyHandler &&
    options.hasQuote !== false &&
    options.isAssistant !== false
  );
}
