import { z } from "zod";
import { CardIdSchema } from "./cards.js";

export const CardGrantSchema = z.enum(["results:read", "cards:read"]);
export type CardGrant = z.infer<typeof CardGrantSchema>;
export type CardAuthorization = {
  owner: string;
  scope: CardGrant;
  tokenId: string;
};
/** A local capability carried by the host, never an HTTP header. */
export const cardAuthorization = Symbol("card authorization");
export const CreateCardTokenSchema = z
  .object({
    request_id: z.string().uuid(),
    secret: z.string().regex(/^loop_card_[A-Za-z0-9_-]{43}$/),
    name: z.string().trim().min(1).max(80),
    scope: CardGrantSchema,
  })
  .strict();
export const CardTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: CardGrantSchema,
  created_at: z.number(),
  revoked_at: z.number().nullable(),
  last_used_at: z.number().nullable(),
});
export type CardToken = z.infer<typeof CardTokenSchema>;

/** Inspect the raw request target once. Never admit a normalized path while
 * forwarding a different raw target into the companion's trusted application. */
export function cardReadRoute(
  method: string | undefined,
  target: string | undefined,
): { kind: "list" | "changes" } | { kind: "detail"; id: string } | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const path = (target || "").split("?", 1)[0];
  if (path === "/api/v1/cards") return { kind: "list" };
  if (path === "/api/v1/cards/changes") return { kind: "changes" };
  const match = /^\/api\/v1\/cards\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    // Literal percent characters belong to the identity. Decode exactly once;
    // a double-encoded prefix still fails CardIdSchema and separators fail it.
    if (!CardIdSchema.safeParse(id).success) return null;
    return { kind: "detail", id };
  } catch {
    return null;
  }
}

/** A client-held creation receipt: high-entropy secret and stable operation ID.
 * Retry this exact request after uncertainty; never persist its secret. */
export function cardTokenRequest(name: string, scope: CardGrant) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret =
    "loop_card_" +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return { request_id: crypto.randomUUID(), secret, name: name.trim(), scope };
}
export type CardTokenRequest = ReturnType<typeof cardTokenRequest>;
