import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { FleetOrigin } from "../shared/fleet.js";
import { fleetPeerApi } from "../shared/fleet-peer-api.js";
import { Problem } from "../shared/problem.js";
import { registrar } from "./registrar.js";
import type { FleetEnrollmentDestination } from "./fleet-enrollment.js";

const paths = new Set(
  Object.values(fleetPeerApi).map((route) => "/api" + route.path),
);

/** This application has only fixed enrollment handlers. It cannot fall through
 * to the workspace API, native providers, browser sessions or local admin. */
export function createFleetEnrollmentHttp(
  destination: FleetEnrollmentDestination,
  origin: () => string,
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  let pending = 0;
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const current = FleetOrigin.safeParse(origin());
    if (!current.success)
      return res
        .status(503)
        .json({ error: "The fleet HTTPS endpoint is unavailable." });
    if (req.headers.host !== new URL(current.data).host)
      return res.status(403).json({ error: "Unrecognized host." });
    if (
      [
        "origin",
        "cookie",
        "authorization",
        "x-loop-csrf",
        "x-http-method-override",
        "x-method-override",
      ].some((header) => req.headers[header] !== undefined) ||
      Object.keys(req.headers).some((header) => header.startsWith("sec-fetch-"))
    )
      return res.status(403).json({
        error: "Use machine enrollment proofs without browser credentials.",
      });
    // Match the raw path before Express normalization or body parsing. No query,
    // encoded path, trailing slash or unrelated route reaches a protocol handler.
    if (!paths.has(req.url))
      return res.status(404).json({ error: "Unknown fleet endpoint." });
    if (req.method !== "POST")
      return res.status(405).json({ error: "Use POST for fleet enrollment." });
    if (req.headers["x-loop-fleet-version"] !== "1")
      return res
        .status(400)
        .json({ error: "Unsupported fleet protocol version." });
    if (
      req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return res.status(415).json({ error: "Use a JSON enrollment request." });
    if (pending >= 16) {
      res.setHeader("Retry-After", "1");
      return res
        .status(503)
        .json({ error: "Fleet enrollment is busy. Try again later." });
    }
    pending++;
    const timer = setTimeout(() => {
      res.destroy();
      req.destroy();
    }, 15_000);
    timer.unref();
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending--;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });
  app.use(express.json({ limit: "4mb", strict: true }));
  const routes = registrar("fleet-enrollment", {
    prefix: "/api",
    automaticOptions: false,
  });
  routes.on(fleetPeerApi.enrollmentProbe, ({ body }, res) =>
    res.json(destination.probe(body)),
  );
  routes.on(fleetPeerApi.enrollmentPrepare, ({ body }, res) =>
    res.json(destination.prepare(body)),
  );
  routes.on(fleetPeerApi.enrollmentCommit, ({ body }, res) =>
    res.json(destination.commit(body)),
  );
  routes.on(fleetPeerApi.enrollmentReceipt, ({ body }, res) =>
    res.json(destination.receipt(body)),
  );
  app.use(routes.mount);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error instanceof Problem)
      return res.status(error.status).json({ error: error.message });
    const status =
      error?.status === 413
        ? 413
        : error instanceof ZodError || error?.type === "entity.parse.failed"
          ? 400
          : 500;
    // Body-parser and Zod diagnostics can include capability-bearing input.
    return res
      .status(status)
      .json({ error: "The fleet enrollment request is unavailable." });
  };
  app.use(errors);
  return app;
}
