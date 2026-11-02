import {
  fleetDeviceAuthenticator,
  fleetLocalAdmission,
  fleetHttpErrors,
} from "./fleet-http-support.js";
import express from "express";
import { fleetAdminApi } from "../shared/fleet-admin-api.js";
import { registrar } from "./registrar.js";
import type { FleetLocalAdmin } from "./fleet-local-admin.js";

export function createFleetAdminHttp(admin: FleetLocalAdmin) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  const authenticate = fleetDeviceAuthenticator(
    admin.pairing,
    "Local device authorization is required for fleet administration.",
  );
  app.use(
    fleetLocalAdmission(
      authenticate,
      60000,
      "Fleet administration is busy. Try again later.",
    ),
  );
  app.use(express.json({ limit: "256kb", strict: true }));
  app.use((req, _res, next) => {
    try {
      authenticate(req);
      next();
    } catch (error) {
      next(error);
    }
  });
  const routes = registrar("fleet-local-admin", {
    prefix: "/api",
    automaticOptions: false,
  });
  routes.on(fleetAdminApi.state, (_req, res) => res.json(admin.state()));
  routes.on(fleetAdminApi.deliveries, ({ body }, res) =>
    res.json(admin.deliveries(body.cursor)),
  );
  routes.on(fleetAdminApi.retryDelivery, ({ body }, res) => {
    admin.retryDelivery(body);
    res.json({ ok: true });
  });
  routes.on(fleetAdminApi.create, ({ body }, res) =>
    res.json(admin.create(body)),
  );
  routes.on(fleetAdminApi.recover, ({ body }, res) =>
    res.json(admin.recover(body)),
  );
  routes.on(fleetAdminApi.remove, ({ body }, res) =>
    res.json(admin.revise(body)),
  );
  routes.on(fleetAdminApi.repairSelf, ({ body }, res) =>
    res.json(admin.revise(body)),
  );
  routes.on(fleetAdminApi.mint, ({ body }, res) => res.json(admin.mint(body)));
  routes.on(fleetAdminApi.begin, ({ body }, res) => {
    const { confirm: _, ...input } = body;
    res.json(admin.source.begin(input));
  });
  routes.on(fleetAdminApi.advance, async (req, res) => {
    const value = await admin.source.advance(req.body.operationId, () =>
      authenticate(res.req),
    );
    authenticate(res.req);
    res.json(value);
  });
  routes.on(fleetAdminApi.reconcile, async (req, res) => {
    const value = await admin.source.reconcile(req.body.operationId, () =>
      authenticate(res.req),
    );
    authenticate(res.req);
    res.json(value);
  });
  routes.on(fleetAdminApi.cancel, ({ body }, res) =>
    res.json(admin.source.cancel(body.operationId)),
  );
  routes.on(fleetAdminApi.list, ({ body }, res) =>
    res.json(admin.list(body.cursor)),
  );
  routes.on(fleetAdminApi.pending, ({ body }, res) =>
    res.json(admin.pending(body.cursor)),
  );
  routes.on(fleetAdminApi.cancelPending, ({ body }, res) => {
    admin.destination.cancel(body.operationId);
    res.json({ ok: true });
  });
  routes.on(fleetAdminApi.handoffBegin, ({ body }, res) => {
    const { confirm: _, ...input } = body;
    res.json(admin.handoff.begin(input));
  });
  routes.on(fleetAdminApi.handoffAdvance, async (req, res) => {
    const value = await admin.handoff.advance(req.body.operationId, () =>
      authenticate(res.req),
    );
    authenticate(res.req);
    res.json(value);
  });
  routes.on(fleetAdminApi.handoffReconcile, async (req, res) => {
    const value = await admin.handoff.reconcile(
      req.body.operationId,
      req.body.origin,
      () => authenticate(res.req),
    );
    authenticate(res.req);
    res.json(value);
  });
  routes.on(fleetAdminApi.handoffList, ({ body }, res) =>
    res.json(admin.handoffs(body.cursor)),
  );
  app.use(routes.mount);
  app.use((_req, res) =>
    res.status(404).json({ error: "Unknown fleet administration endpoint." }),
  );
  app.use(
    fleetHttpErrors("Fleet administration is unavailable.", {
      skipClosedResponses: true,
    }),
  );
  return app;
}
