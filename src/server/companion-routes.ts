import { enableManagedWorkspace, managedWorkspaceInventory } from "./managed-workspace.js";
import { runtimeSetupState } from "../runtime-setup.js";
import { upgradeLauncher } from "../harness-upgrades.js";
import { harnessUpgrades as upgrades } from "./harness-upgrades.js";
import { discover } from "../host-control.js";
import { hostname } from "node:os";
import { nativeHistory } from "./native-history.js";
import { MAX_CONCURRENT_RUNS } from "../../runtime/concurrency.mjs";
import express from "express";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";
import { Problem, owned } from "./domain.js";
import { nativeSessions, OWNER } from "./native-sessions.js";
import { nativeSignIns } from "./native-auth.js";

export const companion = express.Router();
const authHarness = z.enum(["codex", "claude", "pi", "opencode"]);
async function authOptions(
  name: z.infer<typeof authHarness>,
  projectId: string,
) {
  owned("folders", projectId, OWNER);
  const project = db
    .prepare("SELECT path FROM project_paths WHERE folder_id=?")
    .get(projectId) as { path: string } | undefined;
  if (!project)
    throw new Problem(422, "Choose a project directory on this computer.");
  const saved = nativeSessions.registrations().some((r) => r.name === name)
    ? nativeSessions.registration(name)
    : undefined;
  const probe = await discover(name, saved?.executable);
  if (!probe.installed || !probe.supported) throw new Problem(409, probe.help);
  return {
    name,
    executable: probe.executable!,
    project: saved?.project || project.path,
  };
}
companion.get("/workspace/runtimes/:name/auth", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const options = await authOptions(
    authHarness.parse(req.params.name),
    z.string().min(1).parse(req.query.projectId),
  );
  res.json(await nativeSignIns.catalog(options));
});
companion.get("/workspace/runtimes/:name/auth/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(nativeSignIns.status(authHarness.parse(req.params.name)));
});
companion.post("/workspace/runtimes/:name/auth/start", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = z
    .object({
      projectId: z.string().min(1),
      provider: z.string().min(1).max(200),
      method: z.string().min(1).max(100),
      commandId: z.string().uuid(),
    })
    .strict()
    .parse(req.body);
  if (upgrades.busy(req.params.name)) throw new Problem(409, "Wait for the runtime upgrade to finish before signing in.");
  const options = await authOptions(
    authHarness.parse(req.params.name),
    body.projectId,
  );
  res.json(
    await nativeSignIns.start(
      options,
      body.provider,
      body.method,
      body.commandId,
    ),
  );
});
companion.post("/workspace/runtimes/:name/auth/input", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = z
    .object({
      attemptId: z.string().uuid(),
      promptId: z.string().uuid(),
      value: z
        .string()
        .min(1)
        .max(16000)
        .regex(/^[^\r\n]+$/),
    })
    .strict()
    .parse(req.body);
  res.json(
    nativeSignIns.answer(
      authHarness.parse(req.params.name),
      body.attemptId,
      body.promptId,
      body.value,
    ),
  );
});
companion.post("/workspace/runtimes/:name/auth/cancel", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = z
    .object({ attemptId: z.string().uuid() })
    .strict()
    .parse(req.body);
  res.json(
    await nativeSignIns.cancel(
      authHarness.parse(req.params.name),
      body.attemptId,
    ),
  );
});
companion.get("/workspace", (_req, res) =>
  res.json({
    harnesses: nativeSessions.registrations(),
    nativeProcesses: nativeSessions.count,
    concurrency: MAX_CONCURRENT_RUNS,
    hostLifetime: "foreground",
    tunnelOrigin: config.url,
    projectPaths: db.prepare("SELECT * FROM project_paths").all(),
  }),
);
// Runs on the paired execution computer. Never accepts executable paths from the app.
companion.get("/workspace/runtimes", async (_req, res) => {
  const registered = nativeSessions.registrations();
  const managed = await managedWorkspaceInventory(OWNER);
  const runtimes = await Promise.all(
    (["codex", "claude", "pi", "opencode"] as const).map(async (name) => {
      const served = managed?.find((runtime) => runtime.name === name);
      if (served) return served;
      const enabled = registered.find((r) => r.name === name);
      const saved = enabled ? nativeSessions.registration(name) : undefined;
      const probe = await discover(name, saved?.executable);
      return {
        name,
        backend: "direct",
        installed: probe.installed,
        available: !!(probe.installed && probe.supported),
        version: probe.installed ? probe.version : undefined,
        help: probe.help,
        enabled: !!enabled,
        authentication: enabled ? "previously_verified" : "unknown",
        billing: saved?.billing,
        project: saved?.project,
      };
    }),
  );
  res.json({
    computer: hostname(),
    online: true,
    setup: runtimeSetupState(),
    runtimes,
  });
});
companion.get("/workspace/runtimes/:name/upgrade", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const name = authHarness.parse(req.params.name);
  const saved = nativeSessions.registrations().some((r) => r.name === name) ? nativeSessions.registration(name) : undefined;
  const probe = await discover(name, saved?.executable);
  res.json({ upgrade: upgrades.status(name), ...(probe.installed ? upgrades.availability(name, probe.executable!) : { canUpgrade: false, upgradeHelp: "Install this runtime on the computer first." }) });
});
companion.post("/workspace/runtimes/:name/upgrade", async (req, res) => {
  const name = authHarness.parse(req.params.name);
  const { commandId } = z.object({ commandId: z.string().uuid() }).strict().parse(req.body);
  let release: () => void;
  try {
    const previous = upgrades.operation(name, commandId);
    if (previous) { res.json({ upgrade: previous }); return; }
    // Hold the harness before checking for runs: run start checks the same
    // hold, so a run cannot begin between this check and the upgrade.
    release = upgrades.reserve(name);
  } catch (error) { throw new Problem(409, (error as Error).message); }
  try {
    if (nativeSignIns.inProgress(name)) throw new Problem(409, "Finish or cancel sign-in before upgrading.");
    if (db.prepare("SELECT 1 FROM runs WHERE owner_id=? AND state IN ('running','pausing','awaiting_approval') LIMIT 1").get(OWNER))
      throw new Problem(409, "Finish or cancel active runs before upgrading runtimes.");
    const managed = await managedWorkspaceInventory(OWNER);
    if (managed?.some((r) => r.name === name))
      throw new Problem(409, "Upgrade this runtime from its execution environment controls.");
    const saved = nativeSessions.registrations().some((r) => r.name === name) ? nativeSessions.registration(name) : undefined;
    const probe = await discover(name, saved?.executable);
    if (!probe.installed) throw new Problem(409, "Install this runtime on the computer first.");
    let executable: string, upgrade: ReturnType<typeof upgrades.start>;
    try {
      executable = upgradeLauncher(name, probe.executable!);
      // Hand the hold to the upgrade in the same tick.
      release();
      upgrade = upgrades.start(name, executable, commandId);
    } catch (error) { throw new Problem(409, (error as Error).message); }
    if (saved && saved.executable !== executable)
      db.prepare("UPDATE harnesses SET options=? WHERE name=?").run(JSON.stringify({ ...saved, executable }), name);
    res.json({ upgrade });
  } finally {
    release();
  }
});
// Clears a finished upgrade outcome; retry is a new upgrade request.
companion.delete("/workspace/runtimes/:name/upgrade", (req, res) => {
  const name = authHarness.parse(req.params.name);
  try {
    upgrades.dismiss(name);
  } catch (error) { throw new Problem(409, (error as Error).message); }
  res.json({ upgrade: null });
});
companion.post("/workspace/runtimes/:name/upgrade/recover", (req, res) => {
  const name = authHarness.parse(req.params.name);
  const { commandId } = z.object({ confirmedStopped: z.literal(true), commandId: z.string().uuid() }).strict().parse(req.body);
  try { upgrades.recover(name, commandId); }
  catch (error) { throw new Problem(409, (error as Error).message); }
  res.json({ upgrade: upgrades.status(name) });
});
companion.post("/workspace/runtimes/:name/enable", async (req, res) => {
  const name = z
    .enum(["codex", "claude", "pi", "opencode"])
    .parse(req.params.name);
  if (nativeSignIns.inProgress(name))
    throw new Problem(
      409,
      "Finish or cancel this runtime’s sign-in before enabling it.",
    );
  const input = z
    .object({
      projectId: z.string().min(1),
      billing: z.enum(["subscription", "existing"]),
    })
    .strict()
    .parse(req.body);
  owned("folders", input.projectId, OWNER);
  const project = db
    .prepare("SELECT path FROM project_paths WHERE folder_id=?")
    .get(input.projectId) as { path: string } | undefined;
  if (!project)
    throw new Problem(
      422,
      "Choose a project with a directory on this computer. Add one in Projects.",
    );
  const managed = await enableManagedWorkspace(
    OWNER, name, input.projectId, project.path, input.billing,
  );
  if (managed) {
    res.json(managed);
    return;
  }
  const registered = nativeSessions
    .registrations()
    .some((r) => r.name === name);
  const saved = registered ? nativeSessions.registration(name) : undefined;
  if (saved && input.billing !== saved.billing)
    throw new Problem(
      409,
      "This runtime is already enabled with another billing policy. Change it explicitly from the desktop.",
    );
  if (saved && project.path !== saved.project)
    throw new Problem(
      409,
      "This runtime is already bound to another project. Stop the desktop workspace before changing its project.",
    );
  if (input.billing === "subscription" && name === "opencode")
    throw new Problem(
      422,
      "OpenCode cannot verify subscription billing. Choose existing native configuration instead.",
    );
  const probe = await discover(name, saved?.executable);
  if (!probe.installed || !probe.supported || !probe.version)
    throw new Problem(
      409,
      "Install or repair " + name + " on this computer. " + probe.help,
    );
  try {
    res.json(
      await nativeSessions.enable({
        harness: name,
        executable: probe.executable!,
        version: probe.version,
        project: project.path,
        billing: input.billing,
      }),
    );
  } catch (error) {
    if (error instanceof Problem) throw error;
    // Provider/process diagnostics can contain credentials. Return setup guidance,
    // not the raw adapter error, through the paired HTTP boundary.
    throw new Problem(
      422,
      `Could not enable ${name} on this computer. Check its CLI sign-in and configuration, and verify the selected billing policy. Subscription mode requires a supported native subscription; no billing fallback was attempted. Run loop doctor for installation checks, then retry.`,
    );
  }
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
