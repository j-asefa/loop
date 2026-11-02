import {
  fleetDeviceAuthenticator,
  fleetLocalAdmission,
  fleetHttpErrors,
} from "./fleet-http-support.js";
import express from "express";
import { fleetGatewayApi } from "../shared/fleet-gateway-api.js";
import { Problem } from "../shared/problem.js";
import { registrar } from "./registrar.js";
import type { FleetPairing } from "./fleet-pairing.js";
import type { FleetPeerActions } from "./fleet-peer-actions.js";
import type { FleetWorkspaceActions } from "./fleet-workspace-actions.js";
import type { FleetPeerUploads } from "./fleet-peer-uploads.js";
import type { FleetWorkspaceUploads } from "./fleet-workspace-uploads.js";

/** Receipt reads require the serving Host's paired-device delegation, never a
 * browser-supplied owner, peer credential or forwarded authorization header. */
export function createFleetCommandsHttp(
  pairing: FleetPairing,
  actions: FleetPeerActions,
  local?: FleetWorkspaceActions,
  uploads?: FleetPeerUploads,
  localUploads?: FleetWorkspaceUploads,
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  const authenticate = fleetDeviceAuthenticator(
    pairing,
    "Pair this device to check command receipts.",
  );
  app.use(
    fleetLocalAdmission(
      authenticate,
      45000,
      "Command receipts are busy. Try again later.",
    ),
  );
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
        body.route === "uploadCreate"
          ? localUploads?.machineId === body.peer
            ? localUploads.localReceipt(body.commandId, body.payloadDigest)
            : uploads
              ? await uploads.lookup(
                  body.peer,
                  body.commandId,
                  body.payloadDigest,
                  current,
                  controller.signal,
                )
              : (() => {
                  throw new Problem(
                    409,
                    "This gateway cannot check upload receipts. Open the owning workspace.",
                  );
                })()
          : local?.machineId === body.peer
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
  app.use(
    fleetHttpErrors(
      "The command receipt is unavailable. Keep its original identity.",
      { skipClosedResponses: true },
    ),
  );
  return app;
}
