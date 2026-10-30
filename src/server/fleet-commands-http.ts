import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import {
  fleetDeviceAuthorization,
  type FleetDeviceRequest,
} from "../fleet-device-authorization.js";
import { fleetGatewayApi } from "../shared/fleet-gateway-api.js";
import { Problem } from "../shared/problem.js";
import { registrar } from "./registrar.js";
import type { FleetPairing } from "./fleet-pairing.js";
import type { FleetPeerActions } from "./fleet-peer-actions.js";
import type { FleetWorkspaceActions } from "./fleet-workspace-actions.js";

/** Receipt reads require the serving Host's paired-device delegation, never a
 * browser-supplied owner, peer credential or forwarded authorization header. */
export function createFleetCommandsHttp(
  pairing: FleetPairing,
  actions: FleetPeerActions,
  local?: FleetWorkspaceActions,
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  const authenticate = (req: FleetDeviceRequest) => {
    const authorization = req[fleetDeviceAuthorization];
    if (
      !authorization?.active ||
      !authorization.current() ||
      !pairing.device(authorization.deviceId)
    )
      throw new Problem(403, "Pair this device to check command receipts.");
  };
  let pending = 0;
  app.use((req, res, next) => {
    try {
      authenticate(req);
      if (pending >= 16)
        throw new Problem(503, "Command receipts are busy. Try again later.");
      pending++;
      const timer = setTimeout(() => {
        res.destroy();
        req.destroy();
      }, 45_000);
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
    } catch (error) {
      next(error);
    }
  });
  app.use(express.json({ limit: "4kb", strict: true }));
  const routes = registrar("fleet-local-commands", {
    prefix: "/api",
    automaticOptions: false,
  });
  routes.on(fleetGatewayApi.receipt, async ({ body }, res) => {
    const controller = new AbortController();
    const close = () => controller.abort();
    const current = () => authenticate(res.req);
    res.once("close", close);
    try {
      current();
      const receipt =
        local?.machineId === body.peer
          ? local.localReceipt(body.commandId, {
              route: body.route,
              payloadDigest: body.payloadDigest,
            })
          : await actions.lookup(
              body.peer,
              body.commandId,
              { route: body.route, payloadDigest: body.payloadDigest },
              current,
              controller.signal,
            );
      current();
      res.json(receipt);
    } finally {
      res.off("close", close);
    }
  });
  app.use(routes.mount);
  app.use((_req, res) =>
    res.status(404).json({ error: "Unknown fleet command endpoint." }),
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.end();
    const status =
      error instanceof Problem
        ? error.status
        : error?.status === 413
          ? 413
          : error instanceof ZodError || error?.type === "entity.parse.failed"
            ? 400
            : 500;
    res.status(status).json({
      error:
        error instanceof Problem
          ? error.message
          : "The command receipt is unavailable. Keep its original identity.",
    });
  };
  app.use(errors);
  return app;
}
