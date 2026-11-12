import { z } from "zod";
import { Text, MaybeText, Time } from "./route-contract.js";
import { ProviderSchema as Provider } from "./provider-schema.js";
import { ArtifactKindSchema } from "./artifact-kind.js";
import { ArtifactRoleSchema } from "./artifact-role.js";
import { RunDisplayState } from "./run-state.js";
export const PublicArtifact = z.object({
  id: Text,
  owner_id: Text,
  agent_id: MaybeText,
  conversation_id: MaybeText,
  run_id: MaybeText,
  title: Text,
  kind: ArtifactKindSchema,
  role: ArtifactRoleSchema,
  content: Text,
  metadata: Text,
  folder_id: MaybeText,
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
