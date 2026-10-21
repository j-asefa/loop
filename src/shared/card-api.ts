import { z } from "zod";
import {
  CardSchema,
  CardIdSchema,
  CardPageSchema,
  CardChangesSchema,
  CardListQuerySchema,
  CardChangesQuerySchema,
} from "./cards.js";
import { CardTokenSchema, CreateCardTokenSchema } from "./card-access.js";

const noQuery = z.object({}).strict();
export const CardErrorSchema = z.object({ error: z.string() });
export const CreatedCardTokenSchema = z.object({
  token: CardTokenSchema,
  secret: z.string(),
});
/** Executable router paths, response validation and generated API description
 * all consume these definitions. Paths are relative to the /api mount. */
export const cardApi = {
  list: {
    method: "get",
    path: "/v1/cards",
    query: CardListQuerySchema,
    response: CardPageSchema,
    status: 200,
    access: "read",
  },
  changes: {
    method: "get",
    path: "/v1/cards/changes",
    query: CardChangesQuerySchema,
    response: CardChangesSchema,
    status: 200,
    access: "read",
  },
  detail: {
    method: "get",
    path: "/v1/cards/:id",
    query: noQuery,
    id: CardIdSchema,
    response: CardSchema,
    status: 200,
    access: "read",
  },
  tokens: {
    method: "get",
    path: "/card-tokens",
    query: noQuery,
    response: z.array(CardTokenSchema),
    status: 200,
    access: "session",
  },
  createToken: {
    method: "post",
    path: "/card-tokens",
    body: CreateCardTokenSchema,
    response: CreatedCardTokenSchema,
    status: 201,
    access: "session",
  },
  revokeToken: {
    method: "delete",
    path: "/card-tokens/:id",
    id: z.string().min(1),
    response: z.object({ ok: z.literal(true) }),
    status: 200,
    access: "session",
  },
} as const;
