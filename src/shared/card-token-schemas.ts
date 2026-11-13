import { CardTokenId, requestId } from "./contract-ids.js";
import { z } from "zod";
import { TokenScope } from "./token-scopes.js";

export const CreateCardTokenSchema = z.strictObject({
  request_id: requestId(CardTokenId).uuid(),
  name: z.string().trim().min(1).max(80),
  secret: z.string().regex(/^loop_token_[A-Za-z0-9_-]{43}$/),
  scopes: z.array(TokenScope).min(1).max(3),
});
export const CardTokenSchema = z.object({
  id: CardTokenId,
  name: z.string(),
  created_at: z.number(),
  revoked_at: z.number().nullable(),
  last_used_at: z.number().nullable(),
  scopes: z.array(TokenScope).min(1).max(3),
});
export type CardToken = z.infer<typeof CardTokenSchema>;
