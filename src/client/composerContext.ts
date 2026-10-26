export type ComposerContext = {
  agentId: string;
  conversationId: string;
  messageId?: string;
  artifactId?: string;
  title?: string;
  content?: string;
  /** Quoting one of your own prompts rather than the agent. */
  mine?: boolean;
  /** `content` is only the part of the message you highlighted. */
  excerpt?: boolean;
  /** The thread's project, shown before a send. */
  projectName?: string;
};

type Cursor = readonly [number, number, number];
/** The agent's latest message in the open thread. `known` is false for a
 * linked source too old to report it. */
export type LatestAgentMessage = {
  conversationId: string;
  id: string | null;
  known: boolean;
  /** Work in progress or queued: newer messages may arrive first. */
  working: boolean;
};

/**
 * The latest agent message: the one the server reported with its snapshot,
 * or a newer one that has arrived live since. Undefined when the server
 * does not report it.
 */
export function latestAgentMessageId(
  reported: { id: string; cursor: Cursor } | null | undefined,
  messages: readonly { id: string; role: string; cursor?: Cursor }[],
): string | null | undefined {
  if (reported === undefined) return undefined;
  let latest = reported;
  for (const message of messages)
    if (
      message.role === "assistant" &&
      message.cursor &&
      (!latest || compare(message.cursor, latest.cursor) > 0)
    )
      latest = { id: message.id, cursor: message.cursor };
  return latest?.id ?? null;
}
const compare = (a: Cursor, b: Cursor) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Whether a reply quotes the message it answers. A reply to the agent's
 * latest message in an idle thread answers what the thread already ends
 * with, so it goes unquoted; while work is in progress or queued, newer
 * messages may arrive before it, so it is quoted. A highlighted excerpt is
 * always quoted. Undefined while the
 * thread it opens is still loading; the composer then shows and sends it.
 */
export function quotesReply(
  context: ComposerContext,
  openConversation: string | null,
  latest: LatestAgentMessage | null,
): boolean | undefined {
  if (!context.messageId || context.excerpt) return true;
  if (latest?.conversationId === context.conversationId)
    return !latest.known || latest.working || latest.id !== context.messageId;
  return context.conversationId === openConversation ? undefined : true;
}
