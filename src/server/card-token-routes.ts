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
cardTokens.get("/card-tokens", (_req, res) =>
  res.json(listCardTokens(res.locals.owner)),
);
cardTokens.post("/card-tokens", (req, res) =>
  res.status(201).json(createCardToken(res.locals.owner, req.body)),
);
cardTokens.delete("/card-tokens/:id", (req, res) => {
  revokeCardToken(res.locals.owner, req.params.id);
  res.json({ ok: true });
});
