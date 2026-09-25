import { listRuns } from "./run-attention.js";
import { teams, teamFilter } from "./teams.js";
import { runtimeHosts } from "./runtime-hosts.js";
import { subscriptions } from "./subscriptions.js";
import { sharing } from "./sharing.js";
import { mcp } from "./mcp/routes.js";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth, migrateAuth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { enqueue } from "./queue.js";
import { workflows } from "./workflows/routes.js";
import { workspace } from "./workspace-routes.js";
import { core } from "./core-routes.js";
import { Problem } from "./domain.js";
import { ZodError } from "zod";
import { allowedOrigin, initializeAccess, workspaceSession } from "./access.js";
import { migrateMcpUrlCredentials } from "./mcp/credentials.js";
migrateMcpUrlCredentials();
await migrateAuth();
initializeAccess();
export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
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
app.get("/api/auth/get-session", async (req, res, next) => {
  if (config.authMode === "multi-user") return next();
  res.json(await workspaceSession(req));
});
app.all("/api/auth/*splat", (req, res) => {
  if (config.authMode === "single-user") {
    res.status(404).json({
      error: "This is a personal workspace. No Loop account is needed.",
    });
    return;
  }
  return toNodeHandler(auth)(req, res);
});
app.use(express.json({ limit: "12mb" }));
app.get("/api/health", (_req, res) => {
  const worker = db
    .prepare("SELECT max(heartbeat) last FROM worker_health")
    .get() as { last: number | null };
  const ready = !!worker.last && Date.now() - worker.last < 15000;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    database: true,
    worker: ready ? "ready" : "unavailable",
  });
});
app.get("/api/auth-options", (_req, res) =>
  res.json({
    mode: config.authMode,
    github: config.authMode === "multi-user" && !!process.env.GITHUB_CLIENT_ID,
  }),
);
app.use("/api", async (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !allowedOrigin(req)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  const session = await workspaceSession(req);
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
app.use("/api", teams);
app.use("/api", runtimeHosts);
app.use("/api", subscriptions);
app.use("/api", core);
app.use("/api", workspace);
app.use("/api", workflows);
app.use("/api", mcp);
app.use("/api", sharing);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Endpoint not found" }),
);
app.use(express.static("dist/client"));
app.get("/{*splat}", (_req, res) =>
  res.sendFile("index.html", { root: "dist/client" }),
);
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(err instanceof Problem ? err.status : 400).json({
      error:
        err instanceof Problem
          ? err.message
          : err instanceof ZodError
            ? err.issues.map((x) => x.message).join("; ")
            : "Request could not be completed. Please try again.",
    });
  },
);
app.listen(config.port, config.listenHost, () =>
  console.log(`Loop listening on ${config.port}`),
);
