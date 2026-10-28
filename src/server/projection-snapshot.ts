import type { RequestHandler } from "express";
import { db, workspaceClock } from "./db.js";

/** Session projections read their body and watermark in one deferred snapshot.
 * Bearers never receive the owner clock. Routes that record token disclosures
 * acquire the write lock before reading, avoiding a stale WAL snapshot upgrade. */
export function projectionSnapshot(
  handler: RequestHandler<Record<string, string>>,
  options: { bearerWrites?: boolean } = {},
): RequestHandler<Record<string, string>> {
  return (req, res, next) => {
    const snapshot = db.transaction(() => {
      const json = res.json;
      res.json = (body) => {
        if (res.locals.bearer) return json.call(res, body);
        const projection = workspaceClock(res.locals.owner);
        res.locals.workspaceClock = projection;
        return json.call(res, { ...body, projection });
      };
      try {
        return handler(req, res, next);
      } finally {
        res.json = json;
      }
    });
    return res.locals.bearer && options.bearerWrites && req.method !== "HEAD"
      ? snapshot.immediate()
      : snapshot();
  };
}
