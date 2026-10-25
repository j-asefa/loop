import { z } from "zod";
import { workspaceApi, type RouteInput } from "./workspace-api.js";
import { routePath, type RoutePath } from "./route-path.js";

export type CardListInput = Partial<z.output<typeof workspaceApi.cardList.query>>;
export type CardChangesInput = Omit<z.output<typeof workspaceApi.cardChanges.query>, "view"> &
  Partial<Pick<z.output<typeof workspaceApi.cardChanges.query>, "view">>;
type CardReadContract = typeof workspaceApi.cardList | typeof workspaceApi.cardChanges | typeof workspaceApi.cardDetail;
export type CardReadTransport = <C extends CardReadContract>(contract: C, input: RouteInput<C>, signal?: AbortSignal) => Promise<unknown>;

export class CardApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter: number | null = null,
  ) {
    super(message);
  }
}
/** The transport captures one authorized source and its cancellation lifetime. */
export function contractCardReader(request: CardReadTransport) {
  return {
    async list(input: CardListInput = {}, signal?: AbortSignal) {
      return workspaceApi.cardList.response.parse(await request(workspaceApi.cardList, { query: input }, signal));
    },
    async changes(input: CardChangesInput, signal?: AbortSignal) {
      return workspaceApi.cardChanges.response.parse(await request(workspaceApi.cardChanges, { query: input }, signal));
    },
    async detail(id: string, signal?: AbortSignal) {
      return workspaceApi.cardDetail.response.parse(await request(workspaceApi.cardDetail, { params: { id } }, signal));
    },
  };
}
/** Compatibility for the protected App.tsx callers until reactive PR 12b.
 * Paths still come from the same contracts; new browser callers use contracts. */
export function cardReader(
  request: (path: RoutePath<CardReadContract["path"]>, signal?: AbortSignal) => Promise<unknown>,
) {
  return contractCardReader((contract, input, signal) => request(routePath(contract, input), signal));
}
export type CardReader = ReturnType<typeof contractCardReader>;

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
  return contractCardReader(async (contract, input, signal) => {
    const path = routePath(contract, input);
    const response = await send(base.origin + "/api" + path, {
      method: contract.method,
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
