import type { TokenAdmission, TokenScope } from "./token-scopes.js";
import type { CardGrant } from "./card-token-schemas.js";
export {
  CardGrantSchema,
  CardTokenSchema,
  CreateCardTokenSchema,
  type CardGrant,
  type CardToken,
} from "./card-token-schemas.js";

export type CardAuthorization = {
  owner: string;
  admission: TokenAdmission[];
  tokenId: string;
};
/** A local capability carried by the host, never an HTTP header. */
export const cardAuthorization = Symbol("card authorization");
/** A client-held creation receipt: high-entropy secret and stable operation ID.
 * Retry this exact request after uncertainty; never persist its secret. */
export function cardTokenRequest(name: string, scope: CardGrant) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret =
    "loop55_card_" +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return { request_id: crypto.randomUUID(), secret, name: name.trim(), scope };
}
export type CardTokenRequest = ReturnType<typeof cardTokenRequest>;

export function integrationTokenRequest(name: string, scopes: TokenScope[]) {
  const legacy = cardTokenRequest(name, "results:read");
  return {
    request_id: legacy.request_id,
    secret: legacy.secret.replace("loop55_card_", "loop55_token_"),
    name: legacy.name,
    scopes: [...new Set(scopes)].sort(),
  };
}
export type IntegrationTokenRequest = ReturnType<
  typeof integrationTokenRequest
>;
