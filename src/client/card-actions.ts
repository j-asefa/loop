import { executionSourceId } from "./sourceRouting";
import { viewOwner } from "./viewCache";
import type { ResultCard, MessageCard } from "../shared/cards";
import type { Artifact } from "../shared/types";

export type ResultAction =
  | { card: ResultCard; sourceId: string; cardOwner?: string }
  | (Artifact & { card?: undefined; sourceId?: string; cardOwner?: string });

export function resultAction(
  card: ResultCard,
  sourceId = executionSourceId(),
  owner = viewOwner(),
): ResultAction {
  return { card, sourceId, cardOwner: owner };
}

export function resultTarget(item: ResultAction) {
  if (!item.card) return item;
  const card = item.card;
  return {
    id: card.source.artifact_id!,
    agent_id: card.author.id,
    conversation_id: card.source.conversation_id,
    run_id: card.source.run_id,
    folder_id: card.context.folder_id,
    title: card.title,
    content: card.content,
    kind: card.kind,
    version: card.version,
    created_at: card.created_at,
  };
}

export type SavedMessage = {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  role: string;
  personal?: boolean;
  preview: string;
  content?: string;
  created_at: number;
  agent_id: string | null;
  agent_name: string | null;
  provider: string | null;
  project_name: string | null;
  /** Where a saved story is, which is outside Loop. */
  url?: string | null;
};
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
