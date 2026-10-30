import { z } from "zod";
import { TokenScope } from "./token-scopes.js";

export const CardGrantSchema = z.enum(["results:read", "cards:read"]);
export type CardGrant = z.infer<typeof CardGrantSchema>;
const creation = {
  request_id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
};
export const CreateCardTokenSchema = z.union([
  z.strictObject({
    ...creation,
    secret: z.string().regex(/^loop(?:55)?_token_[A-Za-z0-9_-]{43}$/),
    scopes: z.array(TokenScope).min(1).max(3),
  }),
  // Older clients keep their singular grant and creation receipt.
  z.strictObject({
    ...creation,
    secret: z.string().regex(/^loop(?:55)?_card_[A-Za-z0-9_-]{43}$/),
    scope: CardGrantSchema,
  }),
]);
const metadata = {
  id: z.string(),
  name: z.string(),
  created_at: z.number(),
  revoked_at: z.number().nullable(),
  last_used_at: z.number().nullable(),
};
export const CardTokenSchema = z.union([
  z.object({ ...metadata, scopes: z.array(TokenScope).min(1).max(3) }),
  // Preserve the legacy wire shape, including its absence of a scopes field.
  z.object({ ...metadata, scope: CardGrantSchema }),
]);
export type CardToken = z.infer<typeof CardTokenSchema>;
