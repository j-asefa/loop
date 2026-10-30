import { registrar } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { Problem } from "./domain.js";
import {
  createWebhook,
  listWebhooks,
  webhookHistory,
  updateWebhook,
  testWebhook,
  retryWebhook,
  revokeWebhook,
} from "./webhooks.js";

const routes = registrar("webhooks", {
  middleware: [
    [
      "/webhooks",
      (req, _res, next) => {
        if (req.headers.authorization !== undefined)
          throw new Problem(403, "Use your Loop55 session to manage webhooks");
        next();
      },
    ],
  ],
});
export const webhooks = routes.mount;
routes.on(workspaceApi.webhooks, (_input, res) =>
  res.json(listWebhooks(res.locals.owner)),
);
routes.on(workspaceApi.webhookCreate, async ({ body }, res) =>
  res.json(await createWebhook(res.locals.owner, body)),
);
routes.on(workspaceApi.webhookUpdate, ({ params, body }, res) =>
  res.json(
    updateWebhook(res.locals.owner, params.id, body.request_id, body.kinds),
  ),
);
routes.on(workspaceApi.webhookTest, async ({ params, body }, res) =>
  res.json(await testWebhook(res.locals.owner, params.id, body.request_id)),
);
routes.on(workspaceApi.webhookRetry, async ({ params, body }, res) =>
  res.json(await retryWebhook(res.locals.owner, params.id, body.request_id)),
);
routes.on(workspaceApi.webhookRevoke, ({ params, body }, res) =>
  res.json(revokeWebhook(res.locals.owner, params.id, body.request_id)),
);
routes.on(workspaceApi.webhookDeliveries, ({ params }, res) =>
  res.json(webhookHistory(res.locals.owner, params.id)),
);
