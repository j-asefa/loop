import type { TokenAdmission, TokenScope } from "./token-scopes.js";
export {
  CardTokenSchema,
  CreateCardTokenSchema,
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
export function integrationTokenRequest(name: string, scopes: TokenScope[]) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret =
    "loop_token_" +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return {
    request_id: crypto.randomUUID(),
    secret,
    name: name.trim(),
    scopes: [...new Set(scopes)].sort(),
  };
}
export type IntegrationTokenRequest = ReturnType<
  typeof integrationTokenRequest
>;
