export type ReplyContext = {
  id: string;
  content: string;
  name: string;
  created_at: number;
  /** The quoted message is one of your own prompts. */
  mine?: boolean;
};

// Intermediate updates may not be present in the provider's saved history.
// Quote the selected message explicitly, followed by the user's new request.
export function replyPrompt(input: string, reply?: ReplyContext) {
  if (!reply) return input;
  return (
    (reply.mine
      ? "Replying to my earlier message:\n\n"
      : `Replying to this earlier message from @${reply.name}:\n\n`) +
    reply.content
      .split("\n")
      .map((line) => "> " + line)
      .join("\n") +
    "\n\n" +
    input
  );
}
