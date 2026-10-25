import { enabled as memoryEnabled } from "./memory.js";
import { runtimeSetupState } from "../runtime-setup.js";
import { nativeHistory } from "./native-history.js";
import { MAX_CONCURRENT_RUNS } from "../../runtime/concurrency.ts";
import express from "express";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";
import { ownedFolder, ownedConversation, Problem } from "./domain.js";
import { nativeSessions, OWNER } from "./native-sessions.js";
import { executionRequest } from "./execution-client.js";
import { AuthHarness, RuntimeHarness, executionOperations } from "../shared/execution-authority.js";

export const companion = express.Router();
companion.get("/workspace/runtimes/:name/auth", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await executionRequest("auth.catalog", {
    name: AuthHarness.parse(req.params.name), projectId: z.string().min(1).parse(req.query.projectId),
  }));
});
companion.get("/workspace/runtimes/:name/auth/status", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await executionRequest("auth.status", { name: AuthHarness.parse(req.params.name) }));
});
companion.post("/workspace/runtimes/:name/auth/start", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { commandId, ...input } = executionOperations["auth.start"].input.omit({ name: true })
    .extend({ commandId: z.string().uuid() }).parse(req.body);
  res.json(await executionRequest("auth.start", { ...input, name: AuthHarness.parse(req.params.name) }, { commandId }));
});
companion.post("/workspace/runtimes/:name/auth/input", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const input = executionOperations["auth.input"].input.omit({ name: true }).parse(req.body);
  res.json(await executionRequest("auth.input", { ...input, name: AuthHarness.parse(req.params.name) }));
});
companion.post("/workspace/runtimes/:name/auth/cancel", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const input = executionOperations["auth.cancel"].input.omit({ name: true }).parse(req.body);
  res.json(await executionRequest("auth.cancel", { ...input, name: AuthHarness.parse(req.params.name) }));
});
companion.get("/workspace", async (_req, res) => res.json({
  harnesses: nativeSessions.registrations(),
  ...await executionRequest("runtime.status", {}),
  concurrency: MAX_CONCURRENT_RUNS, hostLifetime: "foreground", tunnelOrigin: config.url,
  projectPaths: db.prepare("SELECT * FROM project_paths").all(),
}));
companion.get("/workspace/runtimes", async (req, res) => {
  const runtimes = await executionRequest("runtime.list", { fresh: req.query.fresh === "1" });
  res.json({ ...runtimes, setup: runtimeSetupState() });
});
companion.get("/workspace/runtimes/:name/upgrade", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await executionRequest("upgrade.status", { name: RuntimeHarness.parse(req.params.name) }));
});
companion.post("/workspace/runtimes/:name/upgrade", async (req, res) => {
  const { commandId } = z.strictObject({ commandId: z.string().uuid() }).parse(req.body);
  res.json(await executionRequest("upgrade.start", { name: RuntimeHarness.parse(req.params.name) }, { commandId }));
});
companion.delete("/workspace/runtimes/:name/upgrade", async (req, res) => {
  res.json(await executionRequest("upgrade.dismiss", { name: RuntimeHarness.parse(req.params.name) }));
});
companion.post("/workspace/runtimes/:name/upgrade/recover", async (req, res) => {
  const { commandId, confirmedStopped } = z.strictObject({ confirmedStopped: z.literal(true), commandId: z.string().uuid() }).parse(req.body);
  res.json(await executionRequest("upgrade.recover", { name: RuntimeHarness.parse(req.params.name), confirmedStopped }, { commandId }));
});
companion.post("/workspace/runtimes/:name/enable", async (req, res) => {
  const { commandId, ...input } = executionOperations["runtime.enable"].input.omit({ name: true })
    .extend({ commandId: z.string().uuid().optional() }).parse(req.body);
  res.json(await executionRequest("runtime.enable", { ...input, name: RuntimeHarness.parse(req.params.name) }, { commandId }));
});
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
  ownedFolder(String(req.params.id), OWNER);
  if (db.prepare("SELECT 1 FROM workspace_projects WHERE owner_id=? AND project_id=?").get(OWNER, req.params.id))
    throw new Problem(400, "Choose a named project for a local directory.");
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
  if (conversation) ownedConversation(conversation, OWNER);
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
      answer: z.record(z.string(), z.json()),
    })
    .strict()
    .parse(req.body);
  res.json(
    await executionRequest("native.answer", { decisionId: String(req.params.id), answer: d.answer }, { commandId: d.commandId }),
  );
});
companion.get("/conversations/:id/settings", async (req, res) => {
  const conversation = z.string().uuid().parse(req.params.id);
  ownedConversation(conversation, OWNER);
  res.json(await executionRequest("native.controls", { conversationId: conversation }));
});
companion.patch("/conversations/:id/settings/:setting", async (req, res) => {
  const conversation = z.string().uuid().parse(req.params.id);
  ownedConversation(conversation, OWNER);
  const body = z
    .object({
      value: z.union([z.string().max(1000), z.boolean(), z.number()]),
      revision: z.number().int().nonnegative(),
      generation: z.string().min(1).max(200),
      commandId: z.string().uuid().optional(),
    })
    .strict()
    .parse(req.body);
  res.json(
    await executionRequest("native.setting", {
      conversationId: conversation, setting: String(req.params.setting), value: body.value,
      revision: body.revision, generation: body.generation,
    }, { commandId: body.commandId }),
  );
});
companion.get("/conversations/:id/native", (req, res, next) => {
  const conversation = ownedConversation(String(req.params.id), OWNER);
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
    memoryIncluded: memoryEnabled(OWNER, "conversation:" + req.params.id, false),
    items: items.map((x) => JSON.parse(x.item)),
    projection: true,
    note: "Native history remains authoritative. This is Loop's recorded display projection.",
  });
});

companion.use(nativeHistory);
