import { nativeHistory } from "./native-history.js";
import express from "express";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";
import { Problem, owned } from "./domain.js";
import { nativeSessions, OWNER } from "./native-sessions.js";

export const companion = express.Router();
companion.get("/workspace", (_req, res) =>
  res.json({
    harnesses: nativeSessions.registrations(),
    nativeProcesses: nativeSessions.count,
    concurrency: 8,
    hostLifetime: "foreground",
    tunnelOrigin: config.url,
    projectPaths: db.prepare("SELECT * FROM project_paths").all(),
  }),
);
companion.post("/workspace/projects", (req, res) => {
  const d = z
    .object({
      path: z.string().min(1).max(4096),
      name: z.string().trim().min(1).max(100).optional(),
    })
    .parse(req.body);
  res.status(201).json(nativeSessions.addProject(d.path, d.name));
});
companion.patch("/workspace/projects/:id", (req, res) => {
  owned("folders", String(req.params.id), OWNER);
  const { path } = z
    .object({ path: z.string().min(1).max(4096) })
    .parse(req.body);
  const real = nativeSessions.directory(path);
  if (
    db
      .prepare("SELECT 1 FROM project_paths WHERE path=? AND folder_id<>?")
      .get(real, req.params.id)
  )
    throw new Problem(
      409,
      "That directory already belongs to another project.",
    );
  db.prepare(
    "INSERT INTO project_paths VALUES(?,?) ON CONFLICT(folder_id) DO UPDATE SET path=excluded.path",
  ).run(req.params.id, real);
  res.json({
    ok: true,
    path: real,
    note: "Existing native conversations keep their original directory.",
  });
});
companion.get("/native/decisions", (req, res) => {
  const conversation = z
    .string()
    .uuid()
    .optional()
    .parse(req.query.conversation);
  if (conversation) owned("conversations", conversation, OWNER);
  res.json(
    db
      .prepare(
        "SELECT d.*,a.name,a.provider,r.input FROM native_decisions d JOIN runs r ON r.id=d.run_id LEFT JOIN agents a ON a.id=r.agent_id WHERE d.state IN ('pending','deciding','unknown') AND r.owner_id=? AND (? IS NULL OR d.conversation_id=?) ORDER BY d.created_at",
      )
      .all(OWNER, conversation || null, conversation || null),
  );
});
companion.post("/native/decisions/:id", async (req, res) => {
  const d = z
    .object({
      commandId: z.string().uuid(),
      answer: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(req.body);
  res.json(
    await nativeSessions.answer(String(req.params.id), d.commandId, d.answer),
  );
});
companion.get("/conversations/:id/settings", (req, res) => {
  const conversation = z.string().uuid().parse(req.params.id);
  owned("conversations", conversation, OWNER);
  res.json(nativeSessions.controls(conversation));
});
companion.patch("/conversations/:id/settings/:setting", async (req, res) => {
  const conversation = z.string().uuid().parse(req.params.id);
  owned("conversations", conversation, OWNER);
  const body = z
    .object({
      value: z.union([z.string().max(1000), z.boolean(), z.number()]),
      revision: z.number().int().nonnegative(),
      generation: z.string().min(1).max(200),
    })
    .strict()
    .parse(req.body);
  res.json(
    await nativeSessions.setSetting(
      conversation,
      String(req.params.setting),
      body.value,
      body.revision,
      body.generation,
    ),
  );
});
companion.get("/conversations/:id/native", (req, res, next) => {
  const conversation = owned<any>(
    "conversations",
    String(req.params.id),
    OWNER,
  );
  if (conversation.execution_backend === "hapi") return next();
  const binding = db
    .prepare(
      "SELECT harness,project,model,state,updated_at FROM companion_sessions WHERE conversation_id=?",
    )
    .get(req.params.id);
  const items = db
    .prepare(
      "SELECT item FROM native_items WHERE conversation_id=? ORDER BY updated_at,native_id LIMIT 500",
    )
    .all(req.params.id) as { item: string }[];
  res.json({
    binding,
    items: items.map((x) => JSON.parse(x.item)),
    projection: true,
    note: "Native history remains authoritative. This is Loop's recorded display projection.",
  });
});

companion.use(nativeHistory);
