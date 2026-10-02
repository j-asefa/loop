export type ReplyContext = {
  id: string;
  content: string;
  name: string;
  created_at: number;
  /** The quoted message is one of your own prompts. */
  mine?: boolean;
  /** `content` is the part of the message you highlighted, not all of it. */
  excerpt?: boolean;
};

/** The longest highlighted excerpt a reply can carry. */
export const REPLY_EXCERPT_LIMIT = 4000;
// A whole-message quote keeps its start and end within this many characters.
// The full message stays in Loop; replies never resend an unbounded answer.
export const REPLY_QUOTE_LIMIT = 6000;

function bounded(content: string) {
  if (content.length <= REPLY_QUOTE_LIMIT) return content;
  const head = Math.round(REPLY_QUOTE_LIMIT * 0.7);
  const tail = REPLY_QUOTE_LIMIT - head;
  return (
    content.slice(0, head) +
    `\n[… ${content.length - head - tail} characters omitted …]\n` +
    content.slice(-tail)
  );
}

// Intermediate updates may not be present in the provider's saved history.
// Quote the selected message explicitly, followed by the user's new request.
export function replyPrompt(input: string, reply?: ReplyContext) {
  if (!reply) return input;
  const part = reply.excerpt ? "part of " : "";
  return (
    (reply.mine
      ? `Replying to ${part}my earlier message:\n\n`
      : `Replying to ${part}this earlier message from @${reply.name}:\n\n`) +
    bounded(reply.content)
      .split("\n")
      .map((line) => "> " + line)
      .join("\n") +
    "\n\n" +
    input
  );
}
