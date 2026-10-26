import { workspaceApi } from "./workspace-api.js";
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
  scope: CardGrant;
  tokenId: string;
};
/** A local capability carried by the host, never an HTTP header. */
export const cardAuthorization = Symbol("card authorization");
const readContracts = [
  ["list", workspaceApi.cardList],
  ["changes", workspaceApi.cardChanges],
  ["detail", workspaceApi.cardDetail],
] as const;
const readPaths = readContracts.map(([kind, contract]) => ({
  kind,
  contract,
  pattern: new RegExp(
    "^" +
      ("/api" + contract.path)
        .split("/")
        .map((segment) =>
          segment === ":id"
            ? "([^/]+)"
            : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/") +
      "$",
  ),
}));

/** Inspect the raw request target once. Never admit a normalized path while
 * forwarding a different raw target into the companion's trusted application. */
export function cardReadRoute(
  method: string | undefined,
  target: string | undefined,
): { kind: "list" | "changes" } | { kind: "detail"; id: string } | null {
  const path = (target || "").split("?", 1)[0];
  for (const { kind, contract, pattern } of readPaths) {
    if (
      method !== contract.method &&
      !(method === "HEAD" && contract.method === "GET")
    )
      continue;
    const match = pattern.exec(path);
    if (!match) continue;
    if (kind !== "detail") return { kind };
    try {
      // Decode exactly once. The contract rejects encoded prefixes and separators.
      const params = workspaceApi.cardDetail.params.safeParse({
        id: decodeURIComponent(match[1]),
      });
      return params.success ? { kind, id: params.data.id } : null;
    } catch {
      return null;
    }
  }
  return null;
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
