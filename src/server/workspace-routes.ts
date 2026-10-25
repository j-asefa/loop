import { registrar } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { MessageMetadata, artifactResponse, runResponse } from "./row-schemas.js";
import type { QueryRow } from "./query-records.js";


import { companionMode } from "./profile.js";
import { nativeSessions } from "./native-sessions.js";

import multer from "multer";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { owned, ownedFolder, ownedAgent, ownedArtifact, ownedConnection, ownedImport, ownedConversation, ownedMessage, Problem } from "./domain.js";
import { projectFolders } from "./results.js";
import { ensureWorkspaceProject, isWorkspaceProject } from "./workspace-project.js";
import { moveArtifact, undoMove, naturalDestination } from "./filing.js";
import { saveArtifact } from "./artifacts.js";
import { uploadFile } from "./uploads.js";
import { sendHtmlPreview } from "./file-preview.js";
import { MAX_UPLOAD_BYTES } from "../shared/uploads.js";
import { search, searchStatus } from "./search.js";
import { localModel } from "./local-embeddings.js";
import { stageImport } from "./imports.js";
import { enqueue, RunIdentity, transition } from "./queue.js";
import { checkoutDetail } from "./run-checkouts.js";
import { runVerifications } from "./run-verifications.js";

const routes = registrar("workspace");
export const workspace = routes.mount;
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 200 },
});
routes.on(workspaceApi.uploadCreate, (req, res) => {
  if (!req.file) throw new Problem(400, "Choose a file to upload");
  res.status(201).json(uploadFile(res.locals.owner, req.file, req.body));
}, { middleware: [(req, res, next) =>
  fileUpload.single("file")(req, res, error => {
    if (error) return next(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
      ? new Problem(413, "Files can be up to 25 MB each") : error);
    next();
  })],
});
routes.on(workspaceApi.folderList, (_req, res) => {
  ensureWorkspaceProject(res.locals.owner);
  res.json(
    db
      .prepare("SELECT f.*,EXISTS(SELECT 1 FROM workspace_projects w WHERE w.owner_id=f.owner_id AND w.project_id=f.id) is_workspace FROM folders f WHERE f.owner_id=? ORDER BY f.name")
      .all(res.locals.owner) as z.input<typeof workspaceApi.folderList.response>,
  );
});
routes.on(workspaceApi.folderCreate, (req, res) => {
  const d = req.body;
  if (d.parentId) owned("folders", d.parentId, res.locals.owner);
  if (d.parentId && isWorkspaceProject(res.locals.owner, d.parentId))
    d.parentId = null;
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
  res.status(201).json(ownedFolder(folderId, res.locals.owner) as z.input<typeof workspaceApi.folderCreate.response>);
});
routes.on(workspaceApi.folderUpdate, (req, res) => {
  const f = ownedFolder(req.params.id, res.locals.owner);
  if (isWorkspaceProject(res.locals.owner, f.id))
    throw new Problem(400, "The default Workspace project cannot be renamed, moved, or assigned a directory.");
  const d = req.body;
  if (d.parentId && isWorkspaceProject(res.locals.owner, d.parentId))
    d.parentId = null;
  // A rename or directory edit does not change ancestry. Validate the chain
  // only when changing the parent, including forms that resend the same ID.
  let p = d.parentId === f.parent_id ? null : d.parentId ?? null;
  const visited = new Set([f.id]);
  while (p) {
    if (visited.has(p))
      throw new Problem(400, "Folders cannot contain themselves");
    visited.add(p);
    p = ownedFolder(p, res.locals.owner).parent_id;
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
routes.on(workspaceApi.artifactList, (req, res) => {
  let where = "a.owner_id=? AND a.archived=0";
  const args: unknown[] = [res.locals.owner];
  if (req.query.folder === "inbox") where += " AND a.folder_id IS NULL";
  else if (req.query.folder) {
    owned("folders", String(req.query.folder), res.locals.owner);
    where += isWorkspaceProject(res.locals.owner, String(req.query.folder))
      ? " AND (a.folder_id=? OR a.folder_id IS NULL)"
      : " AND a.folder_id=?";
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
    .all(...args) as z.input<typeof workspaceApi.artifactList.response>["items"];
  res.json({ items, next: items.length === 60 ? items.at(-1)!.cursor : null });
});
// The checkout Loop observed for a run: branch, commits, files and the patch
// stored at capture time. Read-only; there is nothing to apply from here.
routes.on(workspaceApi.runCheckout, (req, res) => {
  owned("runs", req.params.id, res.locals.owner);
  const detail = checkoutDetail(res.locals.owner, req.params.id);
  if (!detail) throw new Problem(404, "This run has no checkout record.");
  res.json(detail);
});
// The verification commands Loop observed for a run, with their exits and
// output tails. Observations of what the agent ran, not what tests exist.
routes.on(workspaceApi.runVerifications, (req, res) => {
  owned("runs", req.params.id, res.locals.owner);
  res.json(runVerifications(res.locals.owner, req.params.id));
});
routes.on(workspaceApi.runFiles, (req, res) => {
  owned("runs", req.params.id, res.locals.owner);
  res.json(
    db
      .prepare(
        "SELECT a.id,a.title,a.metadata FROM artifacts a JOIN artifact_objects f ON f.artifact_id=a.id AND f.owner_id=a.owner_id WHERE a.owner_id=? AND a.run_id=? AND a.archived=0 ORDER BY a.created_at,a.rowid",
      )
      .all(res.locals.owner, req.params.id) as z.input<typeof workspaceApi.runFiles.response>,
  );
});
routes.on(workspaceApi.artifactDetail, (req, res) => {
  const a = ownedArtifact(req.params.id, res.locals.owner);
  const agent = a.agent_id
    ? (db
        .prepare("SELECT name,provider FROM agents WHERE id=? AND owner_id=?")
        .get(a.agent_id, res.locals.owner) as object)
    : undefined;
  res.json({ ...artifactResponse(a), ...agent });
});
routes.on(workspaceApi.artifactCreate, (req, res) => {
  const d = req.body;
  if (d.folder) owned("folders", d.folder, res.locals.owner);
  res.status(201).json({ id: saveArtifact(res.locals.owner, d) });
});
routes.on(workspaceApi.artifactUpdate, (req, res) => {
  const d = req.body;
  db.transaction(() => {
    const a = ownedArtifact(req.params.id, res.locals.owner);
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
  res.json(artifactResponse(ownedArtifact(req.params.id, res.locals.owner)));
});
routes.on(workspaceApi.artifactMove, (req, res) => {
  const d = req.body;
  const folder = d.command
    ? naturalDestination(res.locals.owner, d.command)
    : (d.folderId ?? null);
  res.json(moveArtifact(res.locals.owner, req.params.id, folder));
});
routes.on(workspaceApi.operationUndo, (req, res) =>
  res.json(undoMove(res.locals.owner, req.params.id)),
);
routes.on(workspaceApi.objectFile, (req, res) => {
  const o = db
    .prepare("SELECT * FROM objects WHERE id=? AND owner_id=?")
    .get(req.params.id, res.locals.owner) as QueryRow<"objects"> | undefined;
  if (!o) throw new Problem(404, "File not found");
  if (sendHtmlPreview(res, req.query.preview, o)) return;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(o.name.split("/").at(-1)!)}`,
  );
  res.send(o.bytes);
});
routes.on(workspaceApi.search, async (req, res) => {
  const q = req.query.q;
  res.json(
    await search(res.locals.owner, q, {
      agent: typeof req.query.agent === "string" ? req.query.agent : undefined,
      folder:
        typeof req.query.folder === "string" ? req.query.folder : undefined,
      folders:
        typeof req.query.project === "string"
          ? (owned("folders", req.query.project, res.locals.owner),
            projectFolders(res.locals.owner, req.query.project))
          : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      scope: typeof req.query.scope === "string" ? req.query.scope : undefined,
      from: Number(req.query.from) || undefined,
      to: Number(req.query.to) || undefined,
      before: Number(req.query.before) || 0,
    }) as z.input<typeof workspaceApi.search.response>,
  );
});
routes.on(workspaceApi.searchStatus, (_req, res) =>
  res.json(searchStatus(res.locals.owner)),
);
routes.on(workspaceApi.preferences, (_req, res) =>
  res.json(
    db
      .prepare("SELECT * FROM preferences WHERE owner_id=?")
      .get(res.locals.owner) as z.input<typeof workspaceApi.preferences.response> | undefined || { embedding_enabled: 0 },
  ),
);
routes.on(workspaceApi.preferencesUpdate, (req, res) => {
  const d = req.body;
  if (d.embeddingEnabled && d.connectionId) {
    const c = ownedConnection(d.connectionId || "", res.locals.owner);
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
routes.on(workspaceApi.importPreview, async (req, res) => {
  if (!req.file) throw new Problem(400, "Choose an export file");
  res.json(
    await stageImport(res.locals.owner, req.file.buffer, req.file.originalname) as z.input<typeof workspaceApi.importPreview.response>,
  );
}, { middleware: [upload.single("file")],
});
routes.on(workspaceApi.importList, (_req, res) =>
  res.json(
    db
      .prepare(
        "SELECT * FROM imports WHERE owner_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(res.locals.owner) as z.input<typeof workspaceApi.importList.response>,
  ),
);
routes.on(workspaceApi.importStart, (req, res) => {
  const job = ownedImport(req.params.id, res.locals.owner);
  const active = db
    .prepare(
      "SELECT * FROM runs WHERE owner_id=? AND kind='import' AND json_extract(payload,'$.importId')=? AND state IN ('queued','running','pausing','paused')",
    )
    .get(res.locals.owner, job.id);
  if (active) {
    res.json(active as z.input<typeof workspaceApi.importStart.response>);
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
  res.json(runResponse(run));
});
routes.on(workspaceApi.importCancel, (req, res) => {
  owned("imports", req.params.id, res.locals.owner);
  const jobId = req.params.id;
  const runs = z.array(RunIdentity).parse(db
    .prepare(
      "SELECT id,owner_id FROM runs WHERE owner_id=? AND kind='import' AND json_extract(payload,'$.importId')=?",
    )
    .all(res.locals.owner, jobId));
  runs.forEach((r) => transition(r, "cancelled"));
  db.prepare(
    "UPDATE imports SET status='cancelled' WHERE id=? AND status<>'completed'",
  ).run(jobId);
  res.json({ ok: true });
});
routes.on(workspaceApi.conversationContinue, (req, res) => {
  const c = ownedConversation(req.params.id, res.locals.owner);
  const d = req.body;
  const a = ownedAgent(d.agentId, res.locals.owner);
  if (!a.connection_id)
    throw new Problem(409, "Choose an agent with a connected model");
  const messages = d.messageIds.map((mid) =>
    ownedMessage(mid, res.locals.owner),
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
      db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)").run(
        id(),
        res.locals.owner,
        newId,
        null,
        m.role,
        m.content,
        JSON.stringify(MessageMetadata.parse({
          sourceConversation: c.id,
          sourceMessage: m.id,
          selectedByUser: true,
          attachments: m.metadata.attachments || [],
          original: m.metadata,
        })),
        m.created_at,
      );
  }).immediate();
  res.json({ id: newId, agentId: a.id });
});
