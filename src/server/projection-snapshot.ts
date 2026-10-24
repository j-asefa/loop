import type { RequestHandler } from "express";
import { db, workspaceClock } from "./db.js";

/** Synchronous projection routes read their body and owner watermark in one
 * deferred SQLite snapshot. No writer lock is taken by this wrapper. */
export function projectionSnapshot(
  handler: RequestHandler<Record<string, string>>,
): RequestHandler<Record<string, string>> {
  return (req, res, next) =>
    db.transaction(() => {
      const json = res.json;
      res.json = (body) => {
        const projection = workspaceClock(res.locals.owner);
        res.locals.workspaceClock = projection;
        return json.call(res, { ...body, projection });
      };
      try {
        return handler(req, res, next);
      } finally {
        res.json = json;
      }
    })();
}
