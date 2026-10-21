import { executionSourceId } from "./sourceRouting";
import { viewOwner } from "./viewCache";
import type { ResultCard, MessageCard } from "../shared/cards";
import type { Artifact, Provider } from "../shared/types";
import type { SavedMessage } from "./Later";

/** Compatibility at existing signed-in action boundaries only. Rendering and
 * collection membership use the typed card, never a reconstructed DB row. */
export type CardArtifact = Artifact & {
  card?: ResultCard;
  sourceId?: string;
  cardOwner?: string;
};
export function cardArtifact(
  card: ResultCard,
  sourceId = executionSourceId(),
  owner = viewOwner(),
): CardArtifact {
  return {
    card,
    sourceId,
    cardOwner: owner,
    id: card.source.artifact_id!,
    owner_id: "",
    agent_id: card.author.id,
    conversation_id: card.source.conversation_id,
    run_id: card.source.run_id,
    folder_id: card.context.folder_id,
    name: card.author.name || undefined,
    provider: card.author.provider as Provider | undefined,
    title: card.title,
    content: card.content,
    kind: card.kind,
    pinned: Number(card.saved),
    archived: 0,
    feed_hidden: Number(card.hidden),
    version: card.version,
    created_at: card.created_at,
    updated_at: card.updated_at ?? card.created_at,
    metadata: JSON.stringify({
      messageId: card.source.message_id,
      origin: card.display.imported ? "import" : undefined,
      workflowId: card.display.workflow_id,
    }),
  };
}
export function cardMessage(card: MessageCard): SavedMessage {
  const agent =
    card.recipient || (card.author.kind === "agent" ? card.author : null);
  return {
    message_id: card.source.message_id!,
    conversation_id: card.source.conversation_id!,
    conversation_title: card.context.conversation_title || "Conversation",
    role: card.role,
    personal: card.author.kind === "owner",
    content: card.content,
    preview: card.content,
    created_at: card.created_at,
    agent_id: agent?.id || card.source.agent_id || null,
    agent_name: agent?.name || null,
    provider: agent?.provider || null,
    project_name: card.context.project_name,
  };
}
