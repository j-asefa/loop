import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "../db.js";
import { owned, Problem } from "../domain.js";
import {
  billingPolicy,
  claudePolicy,
  piPolicy,
  verifyAuth,
  nativeSelection,
  type NativeSelection,
} from "./contracts.js";
import {
  environment,
  workerRequest,
  refreshEnvironment,
  hub,
} from "./environments.js";
import { sessionFor, reconcile } from "./adapter.js";
import { enabled } from "../memory.js";
import { environmentUpgrades } from "../harness-upgrades.js";
import { artifactDownload, localArtifact } from "./artifact-storage.js";
import { sendHtmlPreview } from "../file-preview.js";
import { environmentLocation } from "../execution-location.js";
export const executionRoutes = Router();
executionRoutes.get("/environments", (_req, res) =>
  res.json(
    db
      .prepare(
        "SELECT e.host_id id,h.name,e.instance_id,e.state,e.generation,e.capacity,e.health,e.last_seen,e.revoked_at FROM execution_environments e JOIN runtime_hosts h ON h.id=e.host_id WHERE e.owner_id=?",
      )
      .all(res.locals.owner),
  ),
);
executionRoutes.get("/environments/:id/runtimes", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id);
  res.setHeader("Cache-Control", "no-store");
  res.json(await workerRequest(e, "/runtimes"));
});
executionRoutes.post("/environments/:id/runtimes/:flavor/upgrade", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id);
  const body = z.object({ commandId: z.string().uuid(), generation: z.number().int() }).strict().parse(req.body);
  if (e.state !== "online" || body.generation !== e.generation) throw new Problem(409, "The execution environment changed. Refresh before upgrading.");
  const flavor = nativeSelection.shape.flavor.parse(req.params.flavor);
  // Hold the runtime before checking for runs; run dispatch checks the hold.
  const key = e.host_id + ":" + flavor;
  if (environmentUpgrades.has(key)) throw new Problem(409, "Another upgrade request for this runtime is in progress.");
  environmentUpgrades.add(key);
  try {
    if (db.prepare("SELECT 1 FROM runs WHERE owner_id=? AND state IN ('running','pausing','awaiting_approval') LIMIT 1").get(res.locals.owner))
      throw new Problem(409, "Finish or cancel active runs before upgrading runtimes.");
    res.json(await workerRequest(e, "/runtime/upgrade", { ...body, flavor }));
  } finally {
    environmentUpgrades.delete(key);
  }
});
executionRoutes.delete("/environments/:id/runtimes/:flavor/upgrade", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id);
  const flavor = nativeSelection.shape.flavor.parse(req.params.flavor);
  res.json(await workerRequest(e, "/runtime/upgrade/dismiss", { flavor, generation: e.generation }));
});
executionRoutes.post("/environments/:id/runtimes/:flavor/upgrade/recover", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id);
  const body = z.object({ confirmedStopped: z.literal(true), commandId: z.string().uuid(), generation: z.number().int() }).strict().parse(req.body);
  if (e.state !== 'online' || body.generation !== e.generation)
    throw new Problem(409, 'The execution environment changed. Refresh before recovering.');
  const flavor = nativeSelection.shape.flavor.parse(req.params.flavor);
  res.json(await workerRequest(e, '/runtime/upgrade/recover', { ...body, flavor }));
});
executionRoutes.get("/environments/:id/runtimes/:flavor/upgrade", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id);
  const flavor = nativeSelection.shape.flavor.parse(req.params.flavor);
  res.setHeader("Cache-Control", "no-store");
  res.json(await workerRequest(e, "/runtime/upgrade/status", { flavor, generation: e.generation }));
});
executionRoutes.get("/environments/:id/subscription-usage", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id);
  res.setHeader("Cache-Control", "no-store");
  res.json(await workerRequest(e, "/subscription-usage"));
});
executionRoutes.post("/environments/:id/refresh", async (req, res) =>
  res.json(
    await refreshEnvironment(environment(res.locals.owner, req.params.id)),
  ),
);
executionRoutes.get("/environments/:id/projects", (req, res) => {
  environment(res.locals.owner, req.params.id);
  res.json(
    db
      .prepare("SELECT * FROM environment_projects WHERE environment_id=?")
      .all(req.params.id),
  );
});
executionRoutes.put("/environments/:id/projects", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id),
    d = z
      .object({
        projectId: z.string(),
        path: z.string().min(1).max(1000),
        repository: z.string().url().optional(),
      })
      .parse(req.body);
  const project = owned<any>("folders", d.projectId, res.locals.owner);
  if (project.kind !== "project") throw new Problem(400, "Select a project");
  const verified = await workerRequest(e, "/project/verify", {
    path: d.path,
    generation: e.generation,
  });
  db.prepare(
    "INSERT INTO environment_projects VALUES(?,?,?,?) ON CONFLICT(environment_id,project_id) DO UPDATE SET canonical_path=excluded.canonical_path,repository=excluded.repository",
  ).run(e.host_id, d.projectId, verified.path, d.repository || null);
  res.json({ path: verified.path });
});
executionRoutes.post("/environments/:id/projects/clone", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id),
    d = z
      .object({
        projectId: z.string(),
        repository: z.string().url(),
        directory: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      })
      .parse(req.body);
  owned("folders", d.projectId, res.locals.owner);
  const cloned = await workerRequest(e, "/project/clone", {
    repository: d.repository,
    directory: d.directory,
    generation: e.generation,
  });
  db.prepare("INSERT INTO environment_projects VALUES(?,?,?,?)").run(
    e.host_id,
    d.projectId,
    cloned.path,
    d.repository,
  );
  res.json(cloned);
});
executionRoutes.post(
  "/environments/:id/provider/:flavor/:action",
  async (req, res) => {
    const e = environment(res.locals.owner, req.params.id),
      flavor = nativeSelection.shape.flavor.parse(req.params.flavor),
      action = z
        .enum([
          "start",
          "status",
          "providers",
          "input",
          "cancel",
          "code",
          "verify",
        ])
        .parse(req.params.action);
    if (action !== "verify") {
      res.json(
        await workerRequest(e, "/login/" + action, {
          flavor,
          ...(action === "start"
            ? z
                .object({
                  provider: z.string().min(1).max(200).optional(),
                  method: z.string().min(1).max(200).optional(),
                  commandId: z.string().uuid().optional(),
                })
                .parse(req.body)
            : {}),
          ...(action === "input"
            ? z
                .object({
                  attemptId: z.string().uuid(),
                  promptId: z.string().uuid(),
                  value: z.string().max(8192),
                })
                .parse(req.body)
            : {}),
          ...(["code", "cancel"].includes(action)
            ? { attemptId: z.string().uuid().parse(req.body.attemptId) }
            : {}),
          ...(action === "code"
            ? { code: z.string().max(2048).parse(req.body.code) }
            : {}),
        }),
      );
      return;
    }
    res.json(await connectProvider(e, flavor));
  },
);
executionRoutes.post("/environments/:id/revoke", async (req, res) => {
  const e = environment(res.locals.owner, req.params.id);
  db.transaction(() => {
    db.prepare(
      "UPDATE execution_environments SET revoked_at=?,state='revoked',generation=generation+1 WHERE host_id=?",
    ).run(now(), e.host_id);
    db.prepare(
      "UPDATE native_dispatches SET cancel_requested=1,state='cancellation-requested' WHERE environment_id=? AND state NOT IN ('completed','failed','cancelled')",
    ).run(e.host_id);
  }).immediate();
  const sessions = db
    .prepare(
      "SELECT hub_session_id FROM native_sessions WHERE environment_id=? AND hub_session_id IS NOT NULL AND state<>'closed'",
    )
    .all(e.host_id) as any[];
  const attempts = await Promise.allSettled(
    sessions.map((s) =>
      hub(e).request("/api/sessions/" + s.hub_session_id + "/abort", {}),
    ),
  );
  res.json({
    revoked: true,
    stopRequested: attempts.filter((a) => a.status === "fulfilled").length,
    stopAcknowledged: false,
  });
});
executionRoutes.get("/conversations/:id/native", (req, res) => {
  const conversation = owned<any>(
    "conversations",
    req.params.id,
    res.locals.owner,
  );
  const s = sessionFor(req.params.id);
  const pending = db
    .prepare(
      "SELECT id,input,state FROM runs WHERE conversation_id=? AND state='queued' AND NOT EXISTS(SELECT 1 FROM native_dispatches d WHERE d.run_id=runs.id)",
    )
    .all(req.params.id);
  if (!s) {
    res.json({
      backend: conversation.execution_backend,
      pending,
      dispatches: [],
      memoryIncluded: enabled(
        res.locals.owner,
        "conversation:" + req.params.id,
        conversation.execution_backend === "hapi",
      ),
    });
    return;
  }
  const e = db
    .prepare(
      "SELECT h.name,e.state,e.last_seen FROM execution_environments e JOIN runtime_hosts h ON h.id=e.host_id WHERE e.host_id=?",
    )
    .get(s.environment_id);
  res.json({
    backend: "hapi",
    pending,
    memoryIncluded: enabled(res.locals.owner, "conversation:" + req.params.id),
    environment: e,
    flavor: s.flavor,
    billing: JSON.parse(s.billing),
    threadId: s.native_thread_id,
    sessionId: s.hub_session_id,
    coherent: !!s.coherent,
    dispatches: db
      .prepare(
        "SELECT run_id,state,cancel_requested,error,updated_at FROM native_dispatches WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20",
      )
      .all(s.conversation_id),
  });
});
executionRoutes.post("/conversations/:id/reconcile", async (req, res) => {
  owned("conversations", req.params.id, res.locals.owner);
  const s = sessionFor(req.params.id);
  if (!s) throw new Problem(404, "No native session");
  await reconcile(s);
  res.json({ ok: true });
});
executionRoutes.post("/conversations/:id/resume-native", async (req, res) => {
  owned("conversations", req.params.id, res.locals.owner);
  const s = sessionFor(req.params.id);
  if (!s || !s.hub_session_id)
    throw new Problem(409, "No known native session to resume");
  if (
    db
      .prepare(
        "SELECT 1 FROM native_dispatches WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled') AND NOT (state IN ('prepared','blocked') AND send_started_at IS NULL AND cancel_requested=0)",
      )
      .get(s.conversation_id)
  )
    throw new Problem(409, "Reconcile accepted work before resuming");
  if (s.state === "resuming")
    throw new Problem(
      409,
      "Resume acknowledgement is unresolved; reconcile before another attempt",
    );
  const e = environment(s.owner_id, s.environment_id);
  const auth = await workerRequest(e, "/verify", {
    launchId: s.launch_id,
    generation: e.generation,
  });
  verifyAuth(s.flavor, auth);
  db.prepare(
    "UPDATE native_sessions SET state='resuming' WHERE conversation_id=?",
  ).run(s.conversation_id);
  const result = await hub(e).request(
    "/api/sessions/" + s.hub_session_id + "/resume",
    { permissionMode: "default" },
  );
  if (result.sessionId !== s.hub_session_id) {
    const next = await hub(e).request("/api/sessions/" + result.sessionId);
    if ((next.session || next).metadata?.loopLaunchId !== s.launch_id)
      throw new Problem(409, "Resume lineage could not be verified");
  }
  await reconcile(s);
  res.json({ ok: true });
});
executionRoutes.patch("/runs/:id/queued-input", (req, res) => {
  const input = z.string().min(1).max(20000).parse(req.body.input);
  owned("runs", req.params.id, res.locals.owner);
  const changed = db
    .transaction(() => {
      const result = db
        .prepare(
          "UPDATE runs SET input=?,updated_at=? WHERE id=? AND state='queued' AND NOT EXISTS(SELECT 1 FROM native_dispatches WHERE run_id=runs.id)",
        )
        .run(input, now(), req.params.id);
      if (result.changes)
        db.prepare(
          "UPDATE messages SET content=? WHERE run_id=? AND role='user'",
        ).run(input, req.params.id);
      return result.changes;
    })
    .immediate();
  if (!changed) throw new Problem(409, "This prompt has already been admitted");
  res.json({ ok: true });
});
executionRoutes.get("/artifacts/:id/download", async (req, res) =>
  res.redirect(303, await artifactDownload(res.locals.owner, req.params.id)),
);

executionRoutes.post("/conversations/:id/release-native", async (req, res) => {
  owned("conversations", req.params.id, res.locals.owner);
  const s = sessionFor(req.params.id);
  if (!s?.native_thread_id || !s.hub_session_id)
    throw new Problem(409, "A durable native thread is required");
  if (
    db
      .prepare(
        "SELECT 1 FROM native_dispatches WHERE conversation_id=? AND state NOT IN ('completed','failed','cancelled')",
      )
      .get(s.conversation_id)
  )
    throw new Problem(
      409,
      "Accepted work must finish before releasing a process",
    );
  const client = hub(environment(s.owner_id, s.environment_id)),
    detail = await client.request("/api/sessions/" + s.hub_session_id);
  if (Object.keys((detail.session || detail).agentState?.requests || {}).length)
    throw new Problem(409, "Native permission is still pending");
  await client.request("/api/sessions/" + s.hub_session_id + "/archive", {});
  await reconcile(s);
  res.json({ releaseRequested: true });
});

export async function connectProvider(
  e: any,
  flavor: NativeSelection["flavor"],
) {
  const auth = await workerRequest(e, "/auth", { flavor });
  verifyAuth(flavor, auth);
  // Authentication belongs to the runner generation that performed the check.
  // Re-read after the await, before any connection is created or refreshed.
  const current = environment(e.owner_id, e.host_id);
  if (current.state !== "online" || current.generation !== e.generation)
    throw new Problem(409, "The execution environment changed. Retry after it is ready.");
  const prior = db
    .prepare(
      "SELECT id FROM connections WHERE owner_id=? AND json_extract(metadata,'$.backend')='hapi' AND json_extract(metadata,'$.environmentId')=? AND json_extract(metadata,'$.flavor')=?",
    )
    .get(e.owner_id, e.host_id, flavor) as any;
  const connectionId = prior?.id || id();
  const metadata = JSON.stringify({
    backend: "hapi",
    environmentId: e.host_id,
    runtimeHostId: e.host_id,
    runtimeKind: "hapi",
    flavor,
    authMode: flavor === "pi" ? "existing" : "subscription",
    billing: flavor === "pi" ? piPolicy : flavor === "claude" ? claudePolicy : billingPolicy,
    environmentName: e.name,
    location: environmentLocation(e),
  });
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,?,'','connected',?,?,?) ON CONFLICT(id) DO UPDATE SET status='connected',models=excluded.models,metadata=excluded.metadata",
  ).run(
    connectionId,
    e.owner_id,
    flavor === "claude" ? "anthropic" : flavor,
    `${e.name} · ${flavor === "codex" ? "ChatGPT / Codex" : flavor === "opencode" ? "opencode (ChatGPT)" : flavor === "pi" ? "Pi" : "Claude Code"}`,
    JSON.stringify(auth.models || []),
    metadata,
    now(),
  );
  return { id: connectionId, authenticated: true, authMethod: auth.authMethod };
}

executionRoutes.get("/artifacts/:id/file", (req, res) => {
  const file = localArtifact(res.locals.owner, req.params.id);
  const artifact = owned<any>("artifacts", req.params.id, res.locals.owner);
  const name = JSON.parse(artifact.metadata).name || artifact.title;
  if (sendHtmlPreview(res, req.query.preview, { ...file, name })) return;
  const inline =
    req.query.preview === "1" &&
    ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mime);
  res.setHeader("Content-Type", file.mime);
  const filename = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(file.bytes);
});
