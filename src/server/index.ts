import { subscriptions } from "./subscriptions.js";
import { sharing } from "./sharing.js";
import { mcp } from "./mcp/routes.js";
import express from "express";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth, migrateAuth } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { enqueue } from "./queue.js";
import { workflows } from "./workflows/routes.js";
import { workspace } from "./workspace-routes.js";
import { core } from "./core-routes.js";
import { Problem } from "./domain.js";
import { ZodError } from "zod";
await migrateAuth();
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
app.all("/api/auth/*splat", toNodeHandler(auth));
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
  res.json({ github: !!process.env.GITHUB_CLIENT_ID }),
);
app.use("/api", async (req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !== new URL(config.url).origin
  ) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
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
app.get("/api/runs", (_req, res) =>
  res.json(
    db
      .prepare(
        `SELECT r.*,(SELECT count(*)+1 FROM runs older WHERE older.agent_id=r.agent_id AND older.state IN ('queued','running','pausing','paused','awaiting_approval') AND (older.created_at<r.created_at OR (older.created_at=r.created_at AND older.rowid<r.rowid))) queue_position,(SELECT substr(m.content,1,320) FROM messages m WHERE m.run_id=r.id AND m.role='assistant' ORDER BY m.rowid DESC LIMIT 1) preview,(SELECT step_id FROM workflow_steps s WHERE s.run_id=r.id ORDER BY position DESC LIMIT 1) stage FROM runs r WHERE r.owner_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 200`,
      )
      .all(res.locals.owner),
  ),
);
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
app.listen(config.port, "0.0.0.0", () =>
  console.log(`Loop listening on ${config.port}`),
);
