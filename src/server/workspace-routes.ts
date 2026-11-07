import * as foldersQueries from "./sql/folders.js";
import * as projectPathsQueries from "./sql/project-paths.js";
import * as artifactsQueries from "./sql/artifacts.js";
import * as agentsQueries from "./sql/agents.js";
import * as artifactVersionsQueries from "./sql/artifact-versions.js";
import * as objectsQueries from "./sql/objects.js";
import * as preferencesQueries from "./sql/preferences.js";
import * as embeddingsQueries from "./sql/embeddings.js";
import * as searchIndexStatusQueries from "./sql/search-index-status.js";
import * as importsQueries from "./sql/imports.js";
import * as runsQueries from "./sql/runs.js";
import { passiveWorkspaceRead } from "./workspace-read-context.js";
import { recordCardRead, tokenResultPage } from "./card-tokens.js";
import { registrar, projectResponse } from "./registrar.js";
import { workspaceApi } from "../shared/workspace-api.js";
import { artifactResponse, runResponse } from "./row-schemas.js";
import type { QueryRow } from "./query-records.js";

import { nativeSessions } from "./native-sessions.js";

import multer from "multer";
import { z } from "zod";
import { db, id, now } from "./db.js";
import {
  owned,
  ownedFolder,
  ownedAgent,
  ownedArtifact,
  ownedConnection,
  ownedImport,
  Problem,
} from "./domain.js";
import { projectFolders } from "./results.js";
import {
  ensureWorkspaceProject,
  isWorkspaceProject,
} from "./workspace-project.js";
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
import { continueConversation } from "./conversation-continuations.js";

const routes = registrar("workspace");
export const workspace = routes.mount;
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 200 },
});
routes.on(
  workspaceApi.uploadCreate,
  (req, res) => {
    if (!req.file) throw new Problem(400, "Choose a file to upload");
    res.status(201).json(uploadFile(res.locals.owner, req.file, req.body));
  },
  {
    middleware: [
      (req, res, next) =>
        fileUpload.single("file")(req, res, (error) => {
          if (error)
            return next(
              error instanceof multer.MulterError &&
                error.code === "LIMIT_FILE_SIZE"
                ? new Problem(413, "Files can be up to 25 MB each")
                : error,
            );
          next();
        }),
    ],
  },
);
routes.on(workspaceApi.folderList, (_req, res) => {
  if (!passiveWorkspaceRead(res.locals.owner))
    ensureWorkspaceProject(res.locals.owner);
  res.json(
    foldersQueries.workspaceCatalog(db, res.locals.owner) as z.input<
      typeof workspaceApi.folderList.response
    >,
  );
});
routes.on(workspaceApi.folderCreate, (req, res) => {
  const d = req.body;
  if (d.parentId) owned("folders", d.parentId, res.locals.owner);
  if (d.parentId && isWorkspaceProject(res.locals.owner, d.parentId))
    d.parentId = null;
  if (foldersQueries.nameExists(db, res.locals.owner, d.parentId, d.name))
    throw new Problem(409, "A folder with that name already exists here");
  const path = d.path ? nativeSessions.directory(d.path) : undefined;
  if (path && projectPathsQueries.pathExists(db, path))
    throw new Problem(409, "That directory already belongs to a project.");
  const folderId = id();
  db.transaction(() => {
    foldersQueries.insertValues(
      db,
      folderId,
      res.locals.owner,
      d.parentId,
      d.kind,
      d.name,
      now(),
    );
    if (path) projectPathsQueries.insert(db, folderId, path);
  }).immediate();
  res
    .status(201)
    .json(
      ownedFolder(folderId, res.locals.owner) as z.input<
        typeof workspaceApi.folderCreate.response
      >,
    );
});
routes.on(workspaceApi.folderUpdate, (req, res) => {
  const f = ownedFolder(req.params.id, res.locals.owner);
  if (isWorkspaceProject(res.locals.owner, f.id))
    throw new Problem(
      400,
      "The default Workspace project cannot be renamed, moved, or assigned a directory.",
    );
  const d = req.body;
  if (d.parentId && isWorkspaceProject(res.locals.owner, d.parentId))
    d.parentId = null;
  // A rename or directory edit does not change ancestry. Validate the chain
  // only when changing the parent, including forms that resend the same ID.
  let p = d.parentId === f.parent_id ? null : (d.parentId ?? null);
  const visited = new Set([f.id]);
  while (p) {
    if (visited.has(p))
      throw new Problem(400, "Folders cannot contain themselves");
    visited.add(p);
    p = ownedFolder(p, res.locals.owner).parent_id;
  }
  const parent = d.parentId === undefined ? f.parent_id : d.parentId;
  if (
    foldersQueries.otherNameExists(
      db,
      res.locals.owner,
      parent,
      d.name || f.name,
      f.id,
    )
  )
    throw new Problem(409, "That name already exists here");
  const path = d.path ? nativeSessions.directory(d.path) : undefined;
  if (path && projectPathsQueries.usedElsewhere(db, path, f.id))
    throw new Problem(409, "That directory already belongs to a project.");
  db.transaction(() => {
    foldersQueries.renameAndParent(db, d.name || f.name, parent, f.id);
    if (path) projectPathsQueries.upsert(db, f.id, path);
  }).immediate();
  res.json({ ok: true });
});
routes.on(workspaceApi.artifactList, (req, res) => {
  const folder = req.query.folder ? String(req.query.folder) : undefined;
  const agent = req.query.agent ? String(req.query.agent) : undefined;
  if (folder && folder !== "inbox") owned("folders", folder, res.locals.owner);
  if (agent) owned("agents", agent, res.locals.owner);
  const items = artifactsQueries.workspaceList(db, res.locals.owner, {
    folder,
    workspace:
      !!folder &&
      folder !== "inbox" &&
      isWorkspaceProject(res.locals.owner, folder),
    agent,
    pinned: req.query.pinned === "1",
    before: req.query.before ? Number(req.query.before) : undefined,
  });
  res.json(
    tokenResultPage(
      res.locals.owner,
      res.locals.bearer?.tokenId,
      projectResponse(workspaceApi.artifactList, {
        items,
        next: items.length === 60 ? items.at(-1)!.cursor : null,
      }),
      "a:",
      res.req.method !== "HEAD",
    ),
  );
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
    artifactsQueries.runFiles(db, res.locals.owner, req.params.id) as z.input<
      typeof workspaceApi.runFiles.response
    >,
  );
});
routes.on(workspaceApi.artifactDetail, (req, res) => {
  const a = ownedArtifact(req.params.id, res.locals.owner);
  const agent = a.agent_id
    ? (agentsQueries.ownedDisplay(db, a.agent_id, res.locals.owner) as object)
    : undefined;
  const projected = projectResponse(workspaceApi.artifactDetail, {
    ...artifactResponse(a),
    ...agent,
  });
  if (res.locals.bearer && res.req.method !== "HEAD")
    recordCardRead(res.locals.owner, res.locals.bearer.tokenId, [
      "a:" + projected.id,
    ]);
  res.json(projected);
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
    artifactsQueries.edit(
      db,
      d.title ?? a.title,
      d.content ?? a.content,
      d.pinned === undefined ? a.pinned : Number(d.pinned),
      d.archived === undefined ? a.archived : Number(d.archived),
      now(),
      a.id,
    );
    if (d.content !== undefined) {
      artifactsQueries.markEdited(db, a.id);
      artifactVersionsQueries.insertValues(
        db,
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
  const o = objectsQueries.owned(db, req.params.id, res.locals.owner) as
    QueryRow<"objects"> | undefined;
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
    (await search(res.locals.owner, q, {
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
      category: req.query.category,
      from: Number(req.query.from) || undefined,
      to: Number(req.query.to) || undefined,
      before: Number(req.query.before) || 0,
    })) as z.input<typeof workspaceApi.search.response>,
  );
});
routes.on(workspaceApi.searchStatus, (_req, res) =>
  res.json(searchStatus(res.locals.owner)),
);
routes.on(workspaceApi.preferences, (_req, res) =>
  res.json(
    (preferencesQueries.owned(db, res.locals.owner) as
      z.input<typeof workspaceApi.preferences.response> | undefined) || {
      embedding_enabled: 0,
    },
  ),
);
routes.on(workspaceApi.preferencesUpdate, (req, res) => {
  const d = req.body;
  if (d.embeddingEnabled && d.connectionId) {
    const c = ownedConnection(d.connectionId || "", res.locals.owner);
    if (c.provider !== "openai" || c.status !== "connected")
      throw new Problem(400, "Choose a connected OpenAI API account");
  }
  preferencesQueries.upsert(
    db,
    res.locals.owner,
    d.connectionId,
    d.connectionId
      ? process.env.LOOP_EMBEDDING_MODEL || "text-embedding-3-small"
      : localModel,
    Number(d.embeddingEnabled),
  );
  if (!d.embeddingEnabled) embeddingsQueries.removeOwner(db, res.locals.owner);
  searchIndexStatusQueries.removeOwner(db, res.locals.owner);
  res.json({ ok: true });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 2 },
});
routes.on(
  workspaceApi.importPreview,
  async (req, res) => {
    if (!req.file) throw new Problem(400, "Choose an export file");
    res.json(
      (await stageImport(
        res.locals.owner,
        req.file.buffer,
        req.file.originalname,
      )) as z.input<typeof workspaceApi.importPreview.response>,
    );
  },
  { middleware: [upload.single("file")] },
);
routes.on(workspaceApi.importList, (_req, res) =>
  res.json(
    importsQueries.forOwner(db, res.locals.owner) as z.input<
      typeof workspaceApi.importList.response
    >,
  ),
);
routes.on(workspaceApi.importStart, (req, res) => {
  const job = ownedImport(req.params.id, res.locals.owner);
  const active = runsQueries.activeImport(db, res.locals.owner, job.id);
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
  importsQueries.queue(db, job.id);
  res.json(runResponse(run));
});
routes.on(workspaceApi.importCancel, (req, res) => {
  if (!importsQueries.existsOwned(db, req.params.id, res.locals.owner))
    throw new Problem(404, "Item not found");
  const jobId = req.params.id;
  const runs = z
    .array(RunIdentity)
    .parse(runsQueries.importIdentities(db, res.locals.owner, jobId));
  runs.forEach((r) => transition(r, "cancelled"));
  importsQueries.cancel(db, jobId);
  res.json({ ok: true });
});
routes.on(workspaceApi.conversationContinueStart, (req, res) => {
  res.json(continueConversation(res.locals.owner, req.params.id, req.body));
});
