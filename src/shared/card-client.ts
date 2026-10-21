import { cardApi } from "./card-api.js";
import { z } from "zod";
import {
  CardSchema,
  CardPageSchema,
  CardChangesSchema,
  CardListQuerySchema,
  CardChangesQuerySchema,
} from "./cards.js";

export type CardListInput = Partial<z.output<typeof CardListQuerySchema>>;
export type CardChangesInput = Omit<
  z.output<typeof CardChangesQuerySchema>,
  "view"
> &
  Partial<Pick<z.output<typeof CardChangesQuerySchema>, "view">>;
export class CardApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter: number | null = null,
  ) {
    super(message);
  }
}
const parameters = (input: object) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) query.set(key, String(value));
  return query.toString();
};
/** Use the same typed, validated reads with a cookie transport or an integration
 * token. The transport is fixed to one authorized source for its lifetime. */
export function cardReader(
  request: (path: string, signal?: AbortSignal) => Promise<unknown>,
) {
  return {
    async list(input: CardListInput = {}, signal?: AbortSignal) {
      return CardPageSchema.parse(
        await request(cardApi.list.path + "?" + parameters(input), signal),
      );
    },
    async changes(input: CardChangesInput, signal?: AbortSignal) {
      return CardChangesSchema.parse(
        await request(cardApi.changes.path + "?" + parameters(input), signal),
      );
    },
    async detail(id: string, signal?: AbortSignal) {
      return CardSchema.parse(
        await request(
          cardApi.detail.path.replace(":id", encodeURIComponent(id)),
          signal,
        ),
      );
    },
  };
}
export type CardReader = ReturnType<typeof cardReader>;

export function createCardClient({
  baseUrl,
  token,
  fetch: send = fetch,
}: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): CardReader {
  const base = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("Choose the origin URL of one Loop workspace");
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new Error("Cards credentials require HTTPS outside local loopback");
  if (!token || /\s/.test(token))
    throw new Error(
      "Provide a card token through the environment or a secret store",
    );
  return cardReader(async (path, signal) => {
    const response = await send(base.origin + "/api" + path, {
      method: "GET",
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { authorization: "Bearer " + token, accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const retry = Number(response.headers.get("retry-after"));
      throw new CardApiError(
        response.status,
        typeof body?.error === "string" ? body.error : "Card request failed",
        Number.isFinite(retry) && retry > 0 ? retry : null,
      );
    }
    return response.json();
  });
}
