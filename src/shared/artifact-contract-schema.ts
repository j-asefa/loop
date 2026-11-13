import {
  AgentId,
  ArtifactId,
  ConversationId,
  FolderId,
  OwnerId,
  RunId,
} from "./contract-ids.js";
import { z } from "zod";
import { Text, MaybeText, Time } from "./route-contract.js";
import { ProviderSchema as Provider } from "./provider-schema.js";
import { ArtifactKindSchema } from "./artifact-kind.js";
import { ArtifactRoleSchema } from "./artifact-role.js";
import { RunDisplayState } from "./run-state.js";
export const PublicArtifact = z.object({
  id: ArtifactId,
  owner_id: OwnerId,
  agent_id: AgentId.nullable(),
  conversation_id: ConversationId.nullable(),
  run_id: RunId.nullable(),
  title: Text,
  kind: ArtifactKindSchema,
  role: ArtifactRoleSchema,
  content: Text,
  metadata: Text,
  folder_id: FolderId.nullable(),
  pinned: z.number(),
  archived: z.number(),
  feed_hidden: z.number().optional(),
  version: z.number(),
  created_at: Time,
  updated_at: Time,
  name: MaybeText.optional(),
  provider: Provider.nullable().optional(),
  run_state: RunDisplayState.nullable().optional(),
  run_error: MaybeText.optional(),
});
