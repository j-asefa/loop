import { registrar } from "./registrar.js";
import { cardApi } from "../shared/card-api.js";

import {
  createCardToken,
  listCardTokens,
  revokeCardToken,
} from "./card-tokens.js";
import { Problem } from "./domain.js";

/** Mounted only after the ordinary owner/device session boundary. */
const routes = registrar("cardTokens", { strict: true, caseSensitive: true, middleware: [["/card-tokens", (req, _res, next) => {
  if (req.headers.authorization !== undefined)
    throw new Problem(403, "Use your Loop session to manage tokens");
  next();
}]] });
export const cardTokens = routes.mount;

routes.legacy("GET /card-tokens", (_req, res) =>
  res.json(cardApi.tokens.response.parse(listCardTokens(res.locals.owner))),
);
routes.legacy("POST /card-tokens", (req, res) =>
  res
    .status(cardApi.createToken.status)
    .json(
      cardApi.createToken.response.parse(
        createCardToken(res.locals.owner, req.body),
      ),
    ),
);
routes.legacy("DELETE /card-tokens/:id", (req, res) => {
  revokeCardToken(res.locals.owner, req.params.id);
  res.json(cardApi.revokeToken.response.parse({ ok: true }));
});
