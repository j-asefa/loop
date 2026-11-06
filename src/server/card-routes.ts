import { json, type RequestHandler } from "express";
import { registrar, projectResponse } from "./registrar.js";
import { recordCardRead, tokenCardPage } from "./card-tokens.js";
import { workspaceApi } from "../shared/workspace-api.js";

import { cardChanges, cardDetail, listCards } from "./cards.js";
import { Problem } from "./domain.js";
import { TokenAdmissions } from "../shared/token-scopes.js";

const routes = registrar("cards", {
  strict: true,
  caseSensitive: true,
  middleware: [
    [
      "/v1/cards",
      (req, res, next) => {
        if (
          req.headers.authorization !== undefined &&
          !TokenAdmissions.safeParse(res.locals.bearer?.admission).success
        )
          throw new Problem(401, "Invalid integration credential");
        next();
      },
    ],
    // Keep Cards body validation and its size limit at this boundary.
    ["/v1/cards", json({ limit: "12mb" })],
  ],
});
export const cards = routes.mount;

const cardSelection: RequestHandler = (req, res, next) => {
  const bearer = res.locals.bearer;
  if (bearer) {
    if (req.query.view === "done")
      throw new Problem(403, "Done requires an owner session");
  }
  next();
};

routes.on(
  workspaceApi.cardList,
  ({ query }, res) =>
    res.json(
      tokenCardPage(
        res.locals.owner,
        res.locals.bearer?.tokenId,
        listCards(res.locals.owner, query),
        res.req.method !== "HEAD",
      ),
    ),
  { middleware: [cardSelection] },
);
routes.on(
  workspaceApi.cardChanges,
  ({ query }, res) =>
    res.json(
      tokenCardPage(
        res.locals.owner,
        res.locals.bearer?.tokenId,
        cardChanges(res.locals.owner, query),
        res.req.method !== "HEAD",
      ),
    ),
  { middleware: [cardSelection] },
);
routes.on(workspaceApi.cardDetail, ({ params }, res) => {
  const card = projectResponse(
    workspaceApi.cardDetail,
    cardDetail(res.locals.owner, params.id, res.locals.bearer?.admission),
  );
  if (res.locals.bearer?.tokenId && res.req.method !== "HEAD")
    recordCardRead(res.locals.owner, res.locals.bearer?.tokenId, [card.id]);
  res.json(card);
});
