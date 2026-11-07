import * as workerHealthQueries from "./sql/worker-health.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { workspaceApi } from "../shared/workspace-api.js";
import { registrar, mountRoutes, mountedRoute } from "./registrar.js";
import { runResponse } from "./row-schemas.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { assetCacheControl, compressResponse } from "../http-transfer.js";
import { workspaceCapabilities } from "../shared/capabilities.js";
import { companion } from "./companion-routes.js";
import { OWNER } from "./native-sessions.js";
import { listRuns } from "./run-attention.js";
import { teams, teamFilter } from "./teams.js";
import { agentDefinitions } from "./agent-definitions.js";
import { subscriptions } from "./subscriptions.js";
import { sharing } from "./sharing.js";
import { mcp } from "./mcp/routes.js";
import express from "express";

import { config } from "./config.js";
import { db, workspaceClock } from "./db.js";
import { enqueue } from "./queue.js";
import { workspace } from "./workspace-routes.js";
import { core } from "./core-routes.js";
import { news } from "./news.js";
import { feedWatches } from "./feed-watches.js";
import { feedDigests } from "./feed-digests.js";
import { activityRoutes } from "./activities.js";
import { Problem } from "./domain.js";
import { errorHandler } from "./error-handler.js";
import { memoryRoutes } from "./memory.js";
import { notifications } from "./notifications.js";
import { mobile } from "./mobile-routes.js";
import { cards } from "./card-routes.js";
import { cardTokens } from "./card-token-routes.js";
import { webhooks } from "./webhook-routes.js";
import { eventPage, requireTokenEventUpgrade } from "./token-events.js";
import { authenticateCardToken, type CardRequest } from "./card-tokens.js";
import {
  cardAuthorization,
  type CardAuthorization,
} from "../shared/card-access.js";
import { admitsToken, TokenAdmissions } from "../shared/token-scopes.js";
import { prWatches } from "./pr-watches.js";
import { agentMail } from "./agent-mail.js";
import { githubPulls } from "./github-pulls.js";
import { designPreview } from "../preview-context.js";
import { designPreviewBoundary } from "./design-preview.js";
import { currentBuilds } from "./deployments.js";
import { publicBuild } from "../shared/build.js";
import { observedBuild } from "./build-runtime.js";
import { eventLoopHealth } from "./event-loop-health.js";

import { migrateMcpUrlCredentials } from "./mcp/credentials.js";
migrateMcpUrlCredentials();
export const app = express();
app.disable("x-powered-by");
app.use(compressResponse);
// HTTP metadata preserves array and Cards response contracts. Each successful
// owner-session snapshot, including fallback reads, carries the source clock.
app.use("/api", (req, res, next) => {
  if (req.method === "GET") {
    const json = res.json.bind(res);
    res.json = (body) => {
      // Do not attach owner-wide clock metadata to every bearer projection,
      // including write-only grants, even with an owner cookie.
      // The read grant separately admits unchanged event payloads, including
      // committed deadline events; that permission belongs to the event routes.
      if (
        res.locals.owner &&
        res.locals.bearer === undefined &&
        res.statusCode < 400
      ) {
        const clock =
          res.locals.workspaceClock ?? workspaceClock(res.locals.owner);
        res.setHeader("X-Loop-Change-Epoch", clock.epoch);
        res.setHeader("X-Loop-Change-Cursor", String(clock.cursor));
        res.setHeader("X-Loop-Server-Now", String(clock.serverNow));
        res.setHeader("X-Loop-Next-Deadline", String(clock.nextDeadline));
      }
      return json(body);
    };
  }
  next();
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  );
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  if (config.url.startsWith("https://"))
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use((req, _res, next) => {
  if (/^Bearer loop_token_/i.test(req.headers.authorization ?? ""))
    integrationRoute(req);
  next();
});
function integrationRoute(req: IncomingMessage) {
  const contract = mountedRoute(app, req.method, req.url);
  if (
    !contract ||
    typeof contract.access !== "object" ||
    req.headers["x-http-method-override"] !== undefined ||
    req.headers["x-method-override"] !== undefined
  )
    throw new Problem(
      403,
      "Integration credentials permit declared token routes only",
    );
  return contract;
}
function authorizeAdmission(
  req: IncomingMessage,
  context: CardAuthorization | undefined,
) {
  const contract = integrationRoute(req);
  if (
    !context ||
    !TokenAdmissions.safeParse(context.admission).success ||
    context.owner !== OWNER
  )
    throw new Problem(401, "Invalid integration credential");
  if (!admitsToken(contract, context.admission))
    throw new Problem(403, "This token does not permit this route");
  return context;
}
/** The paired host checks the very same mounted contracts before forwarding.
 * Authentication is performed once there; its capability stays on the request. */
export function authorizeIntegrationToken(
  req: IncomingMessage,
): CardAuthorization {
  integrationRoute(req);
  return authorizeAdmission(req, authenticateCardToken(req));
}
// Bearer identities stay separate from owner/device sessions throughout dispatch.
app.use("/api", (req, res, next) => {
  if (req.headers.authorization === undefined) return next();
  // The /api mount trims req.url. Match the raw target the host also receives.
  const target = {
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
  } as IncomingMessage;
  integrationRoute(target);
  try {
    const context = authorizeAdmission(
      target,
      (req as CardRequest)[cardAuthorization],
    );
    res.locals.owner = context.owner;
    res.locals.bearer = {
      tokenId: context.tokenId,
      admission: context.admission,
    };
    next();
  } catch (error) {
    if (error instanceof Problem && error.status === 429)
      res.setHeader("Retry-After", "60");
    next(error);
  }
});
const appCapabilities = registrar("app", {
  prefix: "/api",
  automaticOptions: false,
});
mountRoutes(app, appCapabilities.mount);
appCapabilities.on(
  workspaceApi.capabilities,
  (_req, res) =>
    res.json({ ...workspaceCapabilities(), cardTokens: !designPreview }),
  { middleware: [express.json({ limit: "12mb" })] },
);
const appAuth = registrar("app", { prefix: "/api", automaticOptions: false });
// Host authorizes devices, origins and CSRF before forwarding to this app.
app.use((_req, res, next) => {
  if (!res.locals.bearer) res.locals.owner = OWNER;
  next();
});
mountRoutes(app, appAuth.mount);
appAuth.on(
  workspaceApi.authSession,
  (_req, res) =>
    res.json({ user: { id: OWNER, name: "Your workspace" }, mode: "paired" }),
  { middleware: [express.json({ limit: "12mb" })] },
);
app.use(express.json({ limit: "12mb" }));
const appHealth = registrar("app", { prefix: "/api", automaticOptions: false });
mountRoutes(app, appHealth.mount);
appHealth.on(workspaceApi.health, (_req, res) => {
  const worker = workerHealthQueries.latest(db) as { last: number | null };
  const ready = !!worker.last && Date.now() - worker.last < 15000;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    database: true,
    worker: ready ? (designPreview ? "simulated" : "ready") : "unavailable",
  });
});
if (designPreview) app.use("/api", designPreviewBoundary);
const appSession = registrar("app", {
  prefix: "/api",
  automaticOptions: false,
});
mountRoutes(app, appSession.mount);
appSession.on(workspaceApi.build, (_req, res) =>
  res.json({
    serving: publicBuild(observedBuild()),
    processes: currentBuilds(),
    eventLoop: eventLoopHealth(),
  }),
);
appSession.on(workspaceApi.diagnostic, (req, res) =>
  res.json(
    runResponse(
      enqueue(
        res.locals.owner,
        "Foundation record",
        String(req.body.key || crypto.randomUUID()),
        { kind: "diagnostic" },
      ),
    ),
  ),
);
appSession.on(workspaceApi.events, (req, res) =>
  res.json(
    eventPage(
      res.locals.owner,
      Number(req.query.after) || 0,
      !!res.locals.bearer,
    ),
  ),
);
appSession.on(workspaceApi.tokenEvents, (_req, res) =>
  requireTokenEventUpgrade(res),
);
appSession.on(workspaceApi.runs, (req, res) => {
  const selectedTeams = teamFilter(req.query.teams, res.locals.owner);
  res.json(
    listRuns(
      res.locals.owner,
      selectedTeams,
      req.query.active === "1",
    ) as z.input<typeof workspaceApi.runs.response>,
  );
});
mountRoutes(app, companion, "/api");
mountRoutes(app, teams, "/api");
mountRoutes(app, agentDefinitions, "/api");
mountRoutes(app, agentMail, "/api");
mountRoutes(app, notifications, "/api");
mountRoutes(app, memoryRoutes, "/api");
mountRoutes(app, subscriptions, "/api");
mountRoutes(app, activityRoutes, "/api");
mountRoutes(app, mobile, "/api");
mountRoutes(app, cards, "/api");
mountRoutes(app, cardTokens, "/api");
mountRoutes(app, webhooks, "/api");
mountRoutes(app, prWatches, "/api");
mountRoutes(app, githubPulls, "/api");
mountRoutes(app, news, "/api");
mountRoutes(app, feedWatches, "/api");
mountRoutes(app, feedDigests, "/api");
mountRoutes(app, core, "/api");
mountRoutes(app, workspace, "/api");
mountRoutes(app, mcp, "/api");
mountRoutes(app, sharing, "/api");
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Endpoint not found" }),
);
const compiledClient = fileURLToPath(new URL("../client/", import.meta.url));
const clientRoot = existsSync(compiledClient + "index.html")
  ? compiledClient
  : fileURLToPath(new URL("../../dist/client/", import.meta.url));
const staticOptions = {
  setHeaders(res: ServerResponse, path: string) {
    const publicPath = "/" + relative(clientRoot, path).split(sep).join("/");
    res.setHeader("Cache-Control", assetCacheControl(publicPath));
  },
};
app.use(express.static(clientRoot, staticOptions));
app.get("/{*splat}", (_req, res) =>
  res.sendFile("index.html", {
    root: clientRoot,
    headers: { "Cache-Control": "no-store" },
  }),
);
app.use(errorHandler);
