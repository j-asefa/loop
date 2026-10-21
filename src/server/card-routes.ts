import { recordCardRead, tokenCardPage } from "./card-tokens.js";
import { Router } from "express";
import { cardChanges, cardDetail, listCards } from "./cards.js";
import { Problem } from "./domain.js";
import { cardReadRoute, CardGrantSchema } from "../shared/card-access.js";
import { CardViewSchema } from "../shared/cards.js";

export const cards = Router({ strict: true, caseSensitive: true });
cards.use("/v1/cards", (req, res, next) => {
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
  next();
});
cards.get("/v1/cards", (req, res) =>
  res.json(
    tokenCardPage(
      res.locals.owner,
      res.locals.cardToken,
      listCards(res.locals.owner, req.query),
    ),
  ),
);
cards.get("/v1/cards/changes", (req, res) =>
  res.json(
    tokenCardPage(
      res.locals.owner,
      res.locals.cardToken,
      cardChanges(res.locals.owner, req.query),
    ),
  ),
);
cards.get("/v1/cards/:id", (req, res) => {
  if (Object.keys(req.query).length)
    throw new Problem(400, "Card detail does not accept query parameters");
  const card = cardDetail(
    res.locals.owner,
    req.params.id,
    res.locals.cardScope,
  );
  if (res.locals.cardToken)
    recordCardRead(res.locals.owner, res.locals.cardToken, [card.id]);
  res.json(card);
});
