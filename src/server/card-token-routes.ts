import { cardApi } from "../shared/card-api.js";
import { Router } from "express";
import {
  createCardToken,
  listCardTokens,
  revokeCardToken,
} from "./card-tokens.js";
import { Problem } from "./domain.js";

/** Mounted only after the ordinary owner/device session boundary. */
export const cardTokens = Router({ strict: true, caseSensitive: true });
cardTokens.use("/card-tokens", (req, _res, next) => {
  if (req.headers.authorization !== undefined)
    throw new Problem(403, "Use your Loop session to manage tokens");
  next();
});
cardTokens[cardApi.tokens.method](cardApi.tokens.path, (_req, res) =>
  res.json(cardApi.tokens.response.parse(listCardTokens(res.locals.owner))),
);
cardTokens[cardApi.createToken.method](cardApi.createToken.path, (req, res) =>
  res
    .status(cardApi.createToken.status)
    .json(
      cardApi.createToken.response.parse(
        createCardToken(res.locals.owner, req.body),
      ),
    ),
);
cardTokens[cardApi.revokeToken.method](cardApi.revokeToken.path, (req, res) => {
  revokeCardToken(res.locals.owner, req.params.id);
  res.json(cardApi.revokeToken.response.parse({ ok: true }));
});
