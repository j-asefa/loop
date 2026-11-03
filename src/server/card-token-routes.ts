import { registrar } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";

import {
  createCardToken,
  listCardTokens,
  revokeCardToken,
} from "./card-tokens.js";
import { Problem } from "./domain.js";

/** Mounted only after the ordinary owner/device session boundary. */
const routes = registrar("cardTokens", {
  strict: true,
  caseSensitive: true,
  middleware: [
    [
      "/card-tokens",
      (req, _res, next) => {
        if (req.headers.authorization !== undefined)
          throw new Problem(403, "Use your Loop session to manage tokens");
        next();
      },
    ],
  ],
});
export const cardTokens = routes.mount;

routes.on(workspaceApi.cardTokens, (_input, res) =>
  res.json(listCardTokens(res.locals.owner)),
);
routes.on(workspaceApi.cardTokenCreate, ({ body }, res) =>
  res.json(createCardToken(res.locals.owner, body)),
);
routes.on(workspaceApi.cardTokenRevoke, ({ params }, res) => {
  revokeCardToken(res.locals.owner, params.id);
  res.json({ ok: true });
});
