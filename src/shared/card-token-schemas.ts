import { z } from "zod";

export const CardGrantSchema = z.enum(["results:read", "cards:read"]);
export type CardGrant = z.infer<typeof CardGrantSchema>;
export const CreateCardTokenSchema = z.object({
  request_id: z.string().uuid(),
  secret: z.string().regex(/^loop_card_[A-Za-z0-9_-]{43}$/),
  name: z.string().trim().min(1).max(80),
  scope: CardGrantSchema,
}).strict();
export const CardTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: CardGrantSchema,
  created_at: z.number(),
  revoked_at: z.number().nullable(),
  last_used_at: z.number().nullable(),
});
export type CardToken = z.infer<typeof CardTokenSchema>;
