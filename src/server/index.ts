import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { companionMode, capabilities } from "./profile.js";
import { companion } from "./companion-routes.js";
import { OWNER } from "./native-sessions.js";
import { listRuns } from "./run-attention.js";
import { teams, teamFilter } from "./teams.js";
import { runtimeHosts } from "./runtime-hosts.js";
import { subscriptions } from "./subscriptions.js";
import { sharing } from "./sharing.js";
import { mcp } from "./mcp/routes.js";
import {
  enrollFederationPeer,
  FEDERATION_SETUP_HEADER,
  handleFederationMcp,
  installFederationPeer,
  revokeFederationPeer,
} from "./mcp/federation.js";
import {
  claimReverseCall,
  completeReverseCall,
  handleReverseMcp,
  installReverseCatalog,
  pendingReverseCalls,
} from "./mcp/reverse.js";
import express from "express";
import { toNodeHandler } from "better-auth/node";

import { config } from "./config.js";
import { db, workspaceClock } from "./db.js";
import { enqueue } from "./queue.js";
import { workflows } from "./workflows/routes.js";
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
import { authenticateCardToken, type CardRequest } from "./card-tokens.js";
import { cardAuthorization, cardReadRoute, CardGrantSchema } from "../shared/card-access.js";
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
const access = companionMode ? undefined : await import("./access.js");
const authentication = companionMode ? undefined : await import("./auth.js");
if (authentication) await authentication.migrateAuth();
access?.initializeAccess();
export const app = express();
app.disable("x-powered-by");
// HTTP metadata preserves array and Cards response contracts. Each successful
// owner-session snapshot, including fallback reads, carries the source clock.
app.use("/api", (req, res, next) => {
  if (req.method === "GET") {
    const json = res.json.bind(res);
    res.json = (body) => {
      // Cards grants authorize only their projection, not private workspace
      // activity or approval/watch expiry metadata, even with an owner cookie.
      if (res.locals.owner && res.locals.cardScope === undefined && res.statusCode < 400) {
        const clock = workspaceClock(res.locals.owner);
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
  req.headers["x-loop-client-ip"] =
    process.env.LOOP_BEHIND_PROXY === "1"
      ? String(req.headers["x-forwarded-for"] || "")
          .split(",")
          .at(-1)
          ?.trim() || req.socket.remoteAddress
      : req.socket.remoteAddress;
  next();
});
// Keep the existing federation routes and their independent credential checks
// ahead of the Cards selector. Express owns their case/trailing-slash matching.
if (!companionMode) {
  app.all("/api/mcp/federation", express.json({ limit: "12mb" }), (req, res, next) => {
    void handleFederationMcp(req, res, req.body).catch(next);
  });
  app.all("/api/mcp/reverse", express.json({ limit: "12mb" }), (req, res, next) => {
    void handleReverseMcp(req, res, req.body).catch(next);
  });
}
// Card bearer identities never enter the general session-authorized API.
app.use("/api", (req, res, next) => {
  if (req.headers.authorization === undefined) return next();
  if (!cardReadRoute(req.method, req.originalUrl) || req.headers["x-http-method-override"] !== undefined || req.headers["x-method-override"] !== undefined)
    throw new Problem(403, "Card credentials permit card reads only");
  if (!companionMode && ((req.headers.origin && !access!.allowedOrigin(req)) || req.headers["sec-fetch-site"] === "cross-site"))
    throw new Problem(403, "Origin not allowed");
  try {
    const context = companionMode ? (req as CardRequest)[cardAuthorization] : authenticateCardToken(req);
    if (!context || !CardGrantSchema.safeParse(context.scope).success || (companionMode && context.owner !== OWNER))
      throw new Problem(401, "Invalid card credential");
    res.locals.owner = context.owner;
    res.locals.cardScope = context.scope;
    res.locals.cardToken = context.tokenId;
    cards(req, res, next);
  } catch (error) {
    if (error instanceof Problem && error.status === 429) res.setHeader("Retry-After", "60");
    next(error);
  }
});
app.get("/api/capabilities", (_req, res) => res.json({ ...capabilities, cardTokens: !designPreview }));
if (companionMode) {
  // Host authorizes devices, origins and CSRF before forwarding to this app.
  app.use((_req, res, next) => {
    res.locals.owner = OWNER;
    next();
  });
  app.get("/api/auth/get-session", (_req, res) =>
    res.json({ user: { id: OWNER, name: "Your workspace" }, mode: "paired" }),
  );
  app.get("/api/auth-options", (_req, res) =>
    res.json({ mode: "paired", github: false }),
  );
} else {
  app.get("/api/auth/get-session", async (req, res, next) => {
    if (config.authMode === "multi-user") return next();
    res.json(await access!.workspaceSession(req));
  });
  app.all("/api/auth/*splat", (req, res) => {
    if (config.authMode === "single-user") {
      res.status(404).json({
        error: "This is a personal workspace. No Loop account is needed.",
      });
      return;
    }
    return toNodeHandler(authentication!.auth)(req, res);
  });
  app.get("/api/auth-options", (_req, res) =>
    res.json({
      mode: config.authMode,
      github:
        config.authMode === "multi-user" && !!process.env.GITHUB_CLIENT_ID,
    }),
  );
}
app.use(express.json({ limit: "12mb" }));
app.get("/api/health", (_req, res) => {
  const worker = db
    .prepare("SELECT max(heartbeat) last FROM worker_health")
    .get() as { last: number | null };
  const ready = !!worker.last && Date.now() - worker.last < 15000;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    database: true,
    worker: ready ? (designPreview ? "simulated" : "ready") : "unavailable",
  });
});
app.use("/api", async (req, res, next) => {
  if (companionMode) return next();
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    !access!.allowedOrigin(req)
  ) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  const session = await access!.workspaceSession(req);
  if (!session) {
    res.status(401).json({ error: "Sign in to Loop" });
    return;
  }
  res.locals.owner = session.user.id;
  const window = Math.floor(Date.now() / 60000);
  const count = db
    .prepare(
      "INSERT INTO request_limits VALUES(?,?,1) ON CONFLICT(owner_id) DO UPDATE SET window=excluded.window,count=CASE WHEN request_limits.window=excluded.window THEN request_limits.count+1 ELSE 1 END RETURNING count",
    )
    .get(session.user.id, window) as { count: number };
  if (count.count > 600) {
    res.setHeader("Retry-After", "60");
    res
      .status(429)
      .json({ error: "Too many requests. Try again in a minute." });
    return;
  }
  next();
});
if (designPreview) app.use("/api", designPreviewBoundary);
app.get("/api/build", (_req, res) => res.json({ serving: publicBuild(observedBuild()), processes: currentBuilds(), eventLoop: eventLoopHealth() }));
if (!companionMode) {
  // Setup returns private service credentials. Besides arriving locally, it
  // must carry a header that no paired-browser proxy forwards (they use
  // header allowlists) and that a cross-site page cannot add without CORS.
  const localFederationSetup = (req: express.Request) =>
    config.authMode === "single-user" &&
    access!.localRequest(req) &&
    req.get(FEDERATION_SETUP_HEADER) === "1";
  app.post("/api/mcp/federation/enroll", (req, res) => {
    if (!localFederationSetup(req))
      throw new Problem(403, "Local execution source setup required");
    res.json({
      token: enrollFederationPeer(
        res.locals.owner,
        String(req.body?.peerId || ""),
      ),
    });
  });
  app.post("/api/mcp/federation/import", async (req, res) => {
    if (!localFederationSetup(req))
      throw new Problem(403, "Local execution source setup required");
    const { peerId, label, endpoint, token } = req.body || {};
    if (
      typeof peerId !== "string" ||
      typeof label !== "string" ||
      typeof endpoint !== "string" ||
      typeof token !== "string" ||
      label.length > 80
    )
      throw new Problem(400, "Invalid execution source connection");
    res.json(
      await installFederationPeer(
        res.locals.owner,
        peerId,
        label,
        endpoint,
        token,
      ),
    );
  });
  app.post("/api/mcp/federation/import-reverse", async (req, res) => {
    if (!localFederationSetup(req))
      throw new Problem(403, "Local execution source setup required");
    const { peerId, label, tools } = req.body || {};
    if (
      typeof peerId !== "string" ||
      typeof label !== "string" ||
      label.length > 80
    )
      throw new Problem(400, "Invalid shared tool catalog");
    res.json(
      await installReverseCatalog(res.locals.owner, peerId, label, tools),
    );
  });
  app.post("/api/mcp/federation/revoke", (req, res) => {
    if (!localFederationSetup(req))
      throw new Problem(403, "Local execution source setup required");
    res.json(
      revokeFederationPeer(
        res.locals.owner,
        String(req.body?.peerId || ""),
        true,
      ),
    );
  });
  app.get("/api/mcp/federation/pending", (req, res) => {
    if (!localFederationSetup(req))
      throw new Problem(403, "Local execution source setup required");
    res.json(
      pendingReverseCalls(res.locals.owner, String(req.query.peerId || "")),
    );
  });
  app.post("/api/mcp/federation/claim/:id", (req, res) => {
    if (!localFederationSetup(req))
      throw new Problem(403, "Local execution source setup required");
    const { peerId } = req.body || {};
    if (typeof peerId !== "string")
      throw new Problem(400, "Invalid shared tool claim");
    res.json(claimReverseCall(res.locals.owner, peerId, String(req.params.id)));
  });
  app.post("/api/mcp/federation/complete/:id", (req, res) => {
    if (!localFederationSetup(req))
      throw new Problem(403, "Local execution source setup required");
    const { peerId, state, result } = req.body || {};
    if (typeof peerId !== "string" || !["completed", "unknown"].includes(state))
      throw new Problem(400, "Invalid shared tool result");
    res.json(
      completeReverseCall(
        res.locals.owner,
        peerId,
        String(req.params.id),
        state,
        result,
      ),
    );
  });
}
app.post("/api/diagnostic", (req, res) =>
  res.json(
    enqueue(
      res.locals.owner,
      "Foundation record",
      String(req.body.key || crypto.randomUUID()),
      { kind: "diagnostic" },
    ),
  ),
);
app.get("/api/events", (req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM events WHERE owner_id=? AND id>? ORDER BY id LIMIT 200",
      )
      .all(res.locals.owner, Number(req.query.after) || 0),
  ),
);
app.get("/api/runs", (req, res) => {
  const selectedTeams = teamFilter(req.query.teams, res.locals.owner);
  res.json(listRuns(res.locals.owner, selectedTeams, req.query.active === "1"));
});
if (companionMode) app.use("/api", companion);
app.use("/api", teams);
app.use("/api", agentMail);
app.use("/api", notifications);
app.use("/api", memoryRoutes);
if (capabilities.runtimeHosts) app.use("/api", runtimeHosts);
app.use("/api", subscriptions);
app.use("/api", activityRoutes);
app.use("/api", mobile);
app.use("/api", cards);
app.use("/api", cardTokens);
app.use("/api", prWatches);
app.use("/api", githubPulls);
app.use("/api", news);
app.use("/api", feedWatches);
app.use("/api", feedDigests);
app.use("/api", core);
app.use("/api", workspace);
app.use("/api", workflows);
app.use("/api", mcp);
app.use("/api", sharing);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Endpoint not found" }),
);
const compiledClient = fileURLToPath(new URL("../client/", import.meta.url));
const clientRoot = existsSync(compiledClient + "index.html")
  ? compiledClient
  : fileURLToPath(new URL("../../dist/client/", import.meta.url));
app.use(express.static(clientRoot));
app.get("/{*splat}", (_req, res) =>
  res.sendFile("index.html", { root: clientRoot }),
);
app.use(errorHandler);
