import { companionMode } from "./profile.js";
import { nativeSessions } from "./native-sessions.js";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { owned, Problem } from "./domain.js";
import { moveArtifact, undoMove, naturalDestination } from "./filing.js";
import { saveArtifact } from "./artifacts.js";
import { uploadFile } from "./uploads.js";
import { MAX_UPLOAD_BYTES } from "../shared/uploads.js";
import { search, searchStatus } from "./search.js";
import { localModel } from "./local-embeddings.js";
import { stageImport } from "./imports.js";
import { enqueue, type Run, transition } from "./queue.js";
import type { Artifact, Agent, Message, Connection } from "../shared/types.js";
export const workspace = Router();
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 200 },
});
workspace.post(
  "/uploads",
  (req, res, next) =>
    fileUpload.single("file")(req, res, (error) => {
      next(
        error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
          ? new Problem(413, "Files can be up to 25 MB each")
          : error,
      );
    }),
  (req, res) => {
    if (!req.file) throw new Problem(400, "Choose a file to upload");
    const options = z
      .object({
        folderId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
      })
      .parse(req.body);
    res.status(201).json(uploadFile(res.locals.owner, req.file, options));
  },
);
workspace.get("/folders", (_req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM folders WHERE owner_id=? ORDER BY name")
      .all(res.locals.owner),
  ),
);
workspace.post("/folders", (req, res) => {
  const d = z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .refine((x) => !x.includes("/"), "Use a name without slashes"),
      path: z.string().max(4096).optional(),
      parentId: z.string().nullable().default(null),
      kind: z.enum(["project", "folder"]).default("folder"),
    })
    .parse(req.body);
  if (d.parentId) owned("folders", d.parentId, res.locals.owner);
  if (
    db
      .prepare(
        "SELECT 1 FROM folders WHERE owner_id=? AND parent_id IS ? AND lower(name)=lower(?)",
      )
      .get(res.locals.owner, d.parentId, d.name)
  )
    throw new Problem(409, "A folder with that name already exists here");
  if (d.path && !companionMode)
    throw new Problem(409, "Local project directories require companion mode.");
  const path = d.path ? nativeSessions.directory(d.path) : undefined;
  if (path && db.prepare("SELECT 1 FROM project_paths WHERE path=?").get(path))
    throw new Problem(409, "That directory already belongs to a project.");
  const folderId = id();
  db.transaction(() => {
    db.prepare("INSERT INTO folders VALUES(?,?,?,?,?,?)").run(
      folderId,
      res.locals.owner,
      d.parentId,
      d.kind,
      d.name,
      now(),
    );
    if (path)
      db.prepare("INSERT INTO project_paths VALUES(?,?)").run(folderId, path);
  }).immediate();
  res.status(201).json(owned("folders", folderId, res.locals.owner));
});
workspace.patch("/folders/:id", (req, res) => {
  const f = owned<any>("folders", req.params.id, res.locals.owner);
  const d = z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .refine((x) => !x.includes("/"))
        .optional(),
      path: z.string().max(4096).optional(),
      parentId: z.string().nullable().optional(),
    })
    .parse(req.body);
  let p = d.parentId === undefined ? f.parent_id : d.parentId;
  const visited = new Set([f.id]);
  while (p) {
    if (visited.has(p))
      throw new Problem(400, "Folders cannot contain themselves");
    visited.add(p);
    p = owned<any>("folders", p, res.locals.owner).parent_id;
  }
  const parent = d.parentId === undefined ? f.parent_id : d.parentId;
  if (
    db
      .prepare(
        "SELECT 1 FROM folders WHERE owner_id=? AND parent_id IS ? AND lower(name)=lower(?) AND id<>?",
      )
      .get(res.locals.owner, parent, d.name || f.name, f.id)
  )
    throw new Problem(409, "That name already exists here");
  if (d.path && !companionMode)
    throw new Problem(409, "Local project directories require companion mode.");
  const path = d.path ? nativeSessions.directory(d.path) : undefined;
  if (
    path &&
    db
      .prepare("SELECT 1 FROM project_paths WHERE path=? AND folder_id<>?")
      .get(path, f.id)
  )
    throw new Problem(409, "That directory already belongs to a project.");
  db.transaction(() => {
    db.prepare("UPDATE folders SET name=?,parent_id=? WHERE id=?").run(
      d.name || f.name,
      parent,
      f.id,
    );
    if (path)
      db.prepare(
        "INSERT INTO project_paths VALUES(?,?) ON CONFLICT(folder_id) DO UPDATE SET path=excluded.path",
      ).run(f.id, path);
  }).immediate();
  res.json({ ok: true });
});
workspace.get("/artifacts", (req, res) => {
  let where = "a.owner_id=? AND a.archived=0";
  const args: unknown[] = [res.locals.owner];
  if (req.query.folder === "inbox") where += " AND a.folder_id IS NULL";
  else if (req.query.folder) {
    owned("folders", String(req.query.folder), res.locals.owner);
    where += " AND a.folder_id=?";
    args.push(req.query.folder);
  }
  if (req.query.pinned === "1") where += " AND a.pinned=1";
  if (req.query.agent) {
    owned("agents", String(req.query.agent), res.locals.owner);
    where += " AND a.agent_id=?";
    args.push(req.query.agent);
  }
  if (req.query.before) {
    where += " AND a.rowid<?";
    args.push(Number(req.query.before));
  }
  const items = db
    .prepare(
      `SELECT a.*,json_remove(a.metadata,'$.appResource.html','$.toolResult') AS metadata,a.rowid AS cursor,g.name,g.provider FROM artifacts a LEFT JOIN agents g ON g.id=a.agent_id WHERE ${where} ORDER BY a.rowid DESC LIMIT 60`,
    )
    .all(...args) as any[];
  res.json({ items, next: items.length === 60 ? items.at(-1).cursor : null });
});
workspace.get("/runs/:id/files", (req, res) => {
  owned("runs", req.params.id, res.locals.owner);
  res.json(
    db
      .prepare(
        "SELECT a.id,a.title,a.metadata FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.owner_id=? AND a.run_id=? AND a.archived=0 ORDER BY a.created_at,a.rowid",
      )
      .all(res.locals.owner, req.params.id),
  );
});
workspace.get("/artifacts/:id", (req, res) => {
  const a = owned<Artifact>("artifacts", req.params.id, res.locals.owner);
  const agent = a.agent_id
    ? (db
        .prepare("SELECT name,provider FROM agents WHERE id=? AND owner_id=?")
        .get(a.agent_id, res.locals.owner) as object)
    : undefined;
  res.json({ ...a, ...agent });
});
workspace.post("/artifacts", (req, res) => {
  const d = z
    .object({
      title: z.string().min(1).max(180),
      kind: z
        .enum(["markdown", "code", "table", "diagram", "file", "workflow"])
        .default("markdown"),
      content: z.string().max(200000),
      folder: z.string().optional(),
    })
    .parse(req.body);
  if (d.folder) owned("folders", d.folder, res.locals.owner);
  res.status(201).json({ id: saveArtifact(res.locals.owner, d) });
});
workspace.patch("/artifacts/:id", (req, res) => {
  const d = z
    .object({
      title: z.string().min(1).max(180).optional(),
      content: z.string().max(200000).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      version: z.number().int(),
    })
    .parse(req.body);
  db.transaction(() => {
    const a = owned<Artifact>("artifacts", req.params.id, res.locals.owner);
    if (a.version !== d.version)
      throw new Problem(409, "This item changed. Reopen it before editing.");
    db.prepare(
      "UPDATE artifacts SET title=?,content=?,pinned=?,archived=?,version=version+1,updated_at=? WHERE id=?",
    ).run(
      d.title ?? a.title,
      d.content ?? a.content,
      d.pinned === undefined ? a.pinned : Number(d.pinned),
      d.archived === undefined ? a.archived : Number(d.archived),
      now(),
      a.id,
    );
    if (d.content !== undefined) {
      db.prepare(
        "UPDATE artifacts SET metadata=json_set(metadata,'$.partial',json('false'),'$.edited',json('true')) WHERE id=?",
      ).run(a.id);
      db.prepare("INSERT INTO artifact_versions VALUES(?,?,?,?,?)").run(
        id(),
        a.id,
        a.version + 1,
        d.content,
        now(),
      );
    }
  }).immediate();
  res.json(owned("artifacts", req.params.id, res.locals.owner));
});
workspace.post("/artifacts/:id/move", (req, res) => {
  const d = z
    .object({
      folderId: z.string().nullable().optional(),
      command: z.string().max(400).optional(),
    })
    .parse(req.body);
  const folder = d.command
    ? naturalDestination(res.locals.owner, d.command)
    : (d.folderId ?? null);
  res.json(moveArtifact(res.locals.owner, req.params.id, folder));
});
workspace.post("/operations/:id/undo", (req, res) =>
  res.json(undoMove(res.locals.owner, req.params.id)),
);
workspace.get("/objects/:id", (req, res) => {
  const o = db
    .prepare("SELECT * FROM objects WHERE id=? AND owner_id=?")
    .get(req.params.id, res.locals.owner) as any;
  if (!o) throw new Problem(404, "File not found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(o.name.split("/").at(-1))}`,
  );
  res.send(o.bytes);
});
workspace.get("/search", async (req, res) => {
  const q = z.string().min(1).max(500).parse(req.query.q);
  res.json(
    await search(res.locals.owner, q, {
      agent: typeof req.query.agent === "string" ? req.query.agent : undefined,
      folder:
        typeof req.query.folder === "string" ? req.query.folder : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      scope: typeof req.query.scope === "string" ? req.query.scope : undefined,
      from: Number(req.query.from) || undefined,
      to: Number(req.query.to) || undefined,
      before: Number(req.query.before) || 0,
    }),
  );
});
workspace.get("/search/status", (_req, res) =>
  res.json(searchStatus(res.locals.owner)),
);
workspace.get("/preferences", (_req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM preferences WHERE owner_id=?")
      .get(res.locals.owner) || { embedding_enabled: 0 },
  ),
);
workspace.post("/preferences", (req, res) => {
  const d = z
    .object({
      embeddingEnabled: z.boolean(),
      connectionId: z.string().nullable(),
    })
    .parse(req.body);
  if (d.embeddingEnabled && d.connectionId) {
    const c = owned<Connection>(
      "connections",
      d.connectionId || "",
      res.locals.owner,
    );
    if (c.provider !== "openai" || c.status !== "connected")
      throw new Problem(400, "Choose a connected OpenAI API account");
  }
  db.prepare(
    "INSERT INTO preferences VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET embedding_connection=excluded.embedding_connection,embedding_model=excluded.embedding_model,embedding_enabled=excluded.embedding_enabled",
  ).run(
    res.locals.owner,
    d.connectionId,
    d.connectionId
      ? process.env.LOOP_EMBEDDING_MODEL || "text-embedding-3-small"
      : localModel,
    Number(d.embeddingEnabled),
  );
  if (!d.embeddingEnabled)
    db.prepare("DELETE FROM embeddings WHERE owner_id=?").run(res.locals.owner);
  db.prepare("DELETE FROM search_index_status WHERE owner_id=?").run(
    res.locals.owner,
  );
  res.json({ ok: true });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 2 },
});
workspace.post("/imports/preview", upload.single("file"), async (req, res) => {
  if (!req.file) throw new Problem(400, "Choose an export file");
  res.json(
    await stageImport(res.locals.owner, req.file.buffer, req.file.originalname),
  );
});
workspace.get("/imports", (_req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM imports WHERE owner_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(res.locals.owner),
  ),
);
workspace.post("/imports/:id/start", (req, res) => {
  const job = owned<any>("imports", req.params.id, res.locals.owner);
  const active = db
    .prepare(
      "SELECT * FROM runs WHERE owner_id=? AND kind='import' AND json_extract(payload,'$.importId')=? AND state IN ('queued','running','pausing','paused')",
    )
    .get(res.locals.owner, job.id);
  if (active) {
    res.json(active);
    return;
  }
  if (job.status === "completed") {
    res.json({ status: "completed" });
    return;
  }
  const run = enqueue(res.locals.owner, "Import conversations", id(), {
    kind: "import",
    payload: { importId: job.id },
  });
  db.prepare("UPDATE imports SET status='queued' WHERE id=?").run(job.id);
  res.json(run);
});
workspace.post("/imports/:id/cancel", (req, res) => {
  const job = owned<any>("imports", req.params.id, res.locals.owner);
  const runs = db
    .prepare(
      "SELECT * FROM runs WHERE owner_id=? AND kind='import' AND json_extract(payload,'$.importId')=?",
    )
    .all(res.locals.owner, job.id) as Run[];
  runs.forEach((r) => transition(r, "cancelled"));
  db.prepare(
    "UPDATE imports SET status='cancelled' WHERE id=? AND status<>'completed'",
  ).run(job.id);
  res.json({ ok: true });
});
workspace.post("/conversations/:id/continue", (req, res) => {
  const c = owned<any>("conversations", req.params.id, res.locals.owner);
  const d = z
    .object({
      agentId: z.string(),
      messageIds: z.array(z.string()).min(1).max(200),
    })
    .parse(req.body);
  const a = owned<Agent>("agents", d.agentId, res.locals.owner);
  if (!a.connection_id)
    throw new Problem(409, "Choose an agent with a connected model");
  const messages = d.messageIds.map((mid) =>
    owned<Message>("messages", mid, res.locals.owner),
  );
  if (messages.some((m) => m.conversation_id !== c.id))
    throw new Problem(400, "Choose messages from this conversation only");
  messages.sort((a, b) => a.created_at - b.created_at);
  const newId = id();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,origin,external_id,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      newId,
      res.locals.owner,
      a.id,
      "Continuation: " + c.title,
      "loop-continuation",
      null,
      now(),
    );
    for (const m of messages)
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)").run(
        id(),
        res.locals.owner,
        newId,
        null,
        m.role,
        m.content,
        JSON.stringify({
          sourceConversation: c.id,
          sourceMessage: m.id,
          selectedByUser: true,
          attachments: JSON.parse(m.metadata).attachments || [],
          original: JSON.parse(m.metadata),
        }),
        m.created_at,
      );
  }).immediate();
  res.json({ id: newId, agentId: a.id });
});
