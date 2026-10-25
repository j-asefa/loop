import { json } from "express";
import { registrar, projectResponse } from "./registrar.js";
import { recordCardRead, tokenCardPage } from "./card-tokens.js";
import { workspaceApi } from "../shared/workspace-api.js";

import { cardChanges, cardDetail, listCards } from "./cards.js";
import { Problem } from "./domain.js";
import { cardReadRoute, CardGrantSchema } from "../shared/card-access.js";
import { CardViewSchema } from "../shared/cards.js";

const routes = registrar("cards", { strict: true, caseSensitive: true, middleware: [["/v1/cards", (req, res, next) => {
  const route = cardReadRoute(req.method, req.originalUrl);
  if (!route) throw new Problem(404, "Card route not found");
  if (
    req.headers.authorization !== undefined &&
    !CardGrantSchema.safeParse(res.locals.cardScope).success
  )
    throw new Problem(401, "Invalid card credential");
  if (
    route.kind !== "detail" &&
    res.locals.cardScope === "results:read" &&
    CardViewSchema.parse(req.query.view ?? "results") !== "results"
  )
    throw new Problem(403, "This token permits published results only");
  if (route.kind !== "detail" && res.locals.cardScope && req.query.view === "done")
    throw new Problem(403, "Done requires an owner session");
  next();
}],
// Bearer dispatch reaches this router before the application's JSON parser.
// Keep the same limit and enforce NoBody after the existing admission checks.
["/v1/cards", json({ limit: "12mb" })]] });
export const cards = routes.mount;

routes.on(workspaceApi.cardList, ({ query }, res) =>
  res.json(tokenCardPage(res.locals.owner, res.locals.cardToken, listCards(res.locals.owner, query))),
);
routes.on(workspaceApi.cardChanges, ({ query }, res) =>
  res.json(tokenCardPage(res.locals.owner, res.locals.cardToken, cardChanges(res.locals.owner, query))),
);
routes.on(workspaceApi.cardDetail, ({ params }, res) => {
  const card = projectResponse(workspaceApi.cardDetail, cardDetail(res.locals.owner, params.id, res.locals.cardScope));
  if (res.locals.cardToken)
    recordCardRead(res.locals.owner, res.locals.cardToken, [card.id]);
  res.json(card);
});
