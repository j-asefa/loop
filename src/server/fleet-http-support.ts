import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import {
  fleetDeviceAuthorization,
  type FleetDeviceRequest,
} from "../fleet-device-authorization.js";
import { Problem } from "../shared/problem.js";
import type { FleetPairing } from "./fleet-pairing.js";

export function fleetDeviceAuthenticator(
  pairing: Pick<FleetPairing, "device">,
  message: string,
) {
  return (req: FleetDeviceRequest) => {
    const authorization = req[fleetDeviceAuthorization];
    if (
      !authorization?.active ||
      !authorization.current() ||
      !pairing.device(authorization.deviceId)
    )
      throw new Problem(403, message);
  };
}

export function fleetLocalAdmission(
  authenticate: (req: FleetDeviceRequest) => void,
  timeout: number,
  busyMessage: string,
): RequestHandler {
  let pending = 0;
  return (req, res, next) => {
    try {
      authenticate(req);
      if (pending >= 16) throw new Problem(503, busyMessage);
      pending++;
      const timer = setTimeout(() => {
        res.destroy();
        req.destroy();
      }, timeout);
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
  };
}

// Parser and storage diagnostics can contain capabilities. Only explicit
// domain problems retain their message at the HTTP boundary.
export function fleetHttpErrors(
  message: string,
  options: { skipClosedResponses?: boolean } = {},
): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    if (options.skipClosedResponses && (res.destroyed || res.writableEnded))
      return;
    if (res.headersSent) return res.end();
    const status =
      error instanceof Problem
        ? error.status
        : error?.status === 413
          ? 413
          : error instanceof ZodError || error?.type === "entity.parse.failed"
            ? 400
            : 500;
    return res
      .status(status)
      .json({ error: error instanceof Problem ? error.message : message });
  };
}
