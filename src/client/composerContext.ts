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
