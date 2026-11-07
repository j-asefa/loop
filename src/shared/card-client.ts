import { z } from "zod";
import { workspaceApi, type RouteInput } from "./workspace-api.js";

export type CardListInput = Partial<
  z.output<typeof workspaceApi.cardList.query>
>;
export type CardChangesInput = Omit<
  z.output<typeof workspaceApi.cardChanges.query>,
  "view"
> &
  Partial<Pick<z.output<typeof workspaceApi.cardChanges.query>, "view">>;
type CardReadContract =
  | typeof workspaceApi.cardList
  | typeof workspaceApi.cardChanges
  | typeof workspaceApi.cardDetail;
export type CardReadTransport = <C extends CardReadContract>(
  contract: C,
  input: RouteInput<C>,
  signal?: AbortSignal,
) => Promise<unknown>;

/** The transport captures one authorized source and its cancellation lifetime. */
export function contractCardReader(request: CardReadTransport) {
  return {
    async list(input: CardListInput = {}, signal?: AbortSignal) {
      return workspaceApi.cardList.response.parse(
        await request(workspaceApi.cardList, { query: input }, signal),
      );
    },
    async changes(input: CardChangesInput, signal?: AbortSignal) {
      return workspaceApi.cardChanges.response.parse(
        await request(workspaceApi.cardChanges, { query: input }, signal),
      );
    },
    async detail(id: string, signal?: AbortSignal) {
      return workspaceApi.cardDetail.response.parse(
        await request(workspaceApi.cardDetail, { params: { id } }, signal),
      );
    },
  };
}
export type CardReader = ReturnType<typeof contractCardReader>;
