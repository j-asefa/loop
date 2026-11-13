import { CardTokenId, requestId } from "./contract-ids.js";
import { z } from "zod";
import {
  CardSchema,
  CardIdSchema,
  CardPageSchema,
  CardChangesSchema,
  CardListQuerySchema,
  CardChangesQuerySchema,
} from "./cards.js";
import {
  CardTokenSchema,
  CreateCardTokenSchema,
} from "./card-token-schemas.js";
import { endpoint, base } from "./route-contract.js";
import { CreatedCardTokenSchema } from "./workspace-contract-schemas.js";

export const cardRoutes = {
  cardList: endpoint({
    ...base,
    operation: "cardList",
    method: "GET",
    path: "/v1/cards",
    query: CardListQuerySchema,
    response: CardPageSchema,
    access: { admits: ["read"] },
  }),
  cardChanges: endpoint({
    ...base,
    operation: "cardChanges",
    method: "GET",
    path: "/v1/cards/changes",
    query: CardChangesQuerySchema,
    response: CardChangesSchema,
    access: { admits: ["read"] },
  }),
  cardDetail: endpoint({
    ...base,
    operation: "cardDetail",
    method: "GET",
    path: "/v1/cards/:id",
    params: z.object({ id: CardIdSchema }),
    query: z.strictObject(
      {},
      { error: "Card detail does not accept query parameters" },
    ),
    response: CardSchema,
    access: { admits: ["read"] },
  }),
  cardTokens: endpoint({
    ...base,
    operation: "cardTokens",
    method: "GET",
    path: "/card-tokens",
    response: z.array(CardTokenSchema),
  }),
  cardTokenCreate: endpoint({
    ...base,
    operation: "cardTokenCreate",
    method: "POST",
    path: "/card-tokens",
    body: CreateCardTokenSchema,
    response: CreatedCardTokenSchema,
    status: 201,
  }),
  cardTokenRevoke: endpoint({
    ...base,
    operation: "cardTokenRevoke",
    method: "DELETE",
    path: "/card-tokens/:id",
    params: z.object({ id: requestId(CardTokenId).min(1) }),
    response: z.object({ ok: z.literal(true) }),
  }),
} as const;
