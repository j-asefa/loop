import { Router } from "express";
import { cardChanges, cardDetail, listCards } from "./cards.js";
import { Problem } from "./domain.js";

export const cards = Router({ strict: true, caseSensitive: true });
cards.use("/v1/cards", (req, _res, next) => {
  // Integration authentication is introduced separately. Never accidentally
  // interpret an unrecognized credential as the surrounding browser session.
  if (req.headers.authorization !== undefined)
    throw new Problem(401, "Invalid card credential");
  next();
});
cards.get("/v1/cards", (req, res) =>
  res.json(listCards(res.locals.owner, req.query)),
);
cards.get("/v1/cards/changes", (req, res) =>
  res.json(cardChanges(res.locals.owner, req.query)),
);
cards.get("/v1/cards/:id", (req, res) => {
  if (Object.keys(req.query).length)
    throw new Problem(400, "Card detail does not accept query parameters");
  res.json(cardDetail(res.locals.owner, req.params.id));
});
