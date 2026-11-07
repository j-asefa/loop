import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { applyMigrations } from "../src/server/migrations";
import {
  DEFINITION_EXAMPLES,
  MAX_DEFINITION_BYTES,
} from "../src/shared/agent-definitions";

const dir = mkdtempSync(join(tmpdir(), "loop-definitions-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
// Seed the historical subset through the current named migration ledger.
const existing = new Database(join(dir, "loop.db"));
const migrationDir = join(dir, "migrations");
mkdirSync(migrationDir);
for (const file of readdirSync("migrations")
  .filter((file) => file.endsWith(".sql") && Number(file.split("-")[0]) <= 119)
  .sort())
  copyFileSync(join("migrations", file), join(migrationDir, file));
applyMigrations(existing, migrationDir);
existing.close();
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { agentDefinitions } = await import("../src/server/agent-definitions");
const { teams } = await import("../src/server/teams");
const { core } = await import("../src/server/core-routes");
const { errorHandler } = await import("../src/server/error-handler");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.locals.owner = req.get("x-test-owner") || "alice";
  next();
});
app.use(agentDefinitions, teams, core, errorHandler);
let server: ReturnType<typeof app.listen>, origin: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function request(
  path: string,
  body?: unknown,
  method?: string,
  owner = "alice",
) {
  const response = await fetch(origin + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-test-owner": owner },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
function connection(owner = "alice") {
  const connectionId = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connectionId,
    owner,
    seal("private-fixture-secret", owner),
    JSON.stringify([{ id: "fixture", effortLevels: [{ value: "high" }] }]),
    now(),
  );
  return connectionId;
}
function folder(owner = "alice") {
  const folderId = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Definition project',?)",
  ).run(folderId, owner, now());
  return folderId;
}
const c = connection(),
  project = folder();
async function save(markdown = DEFINITION_EXAMPLES.agent, owner = "alice") {
  const result = await request(
    `/agent-definitions/${id()}`,
    { markdown, version: 0 },
    "PUT",
    owner,
  );
  expect(result.status).toBe(200);
  return result.data;
}
function creation(extra: object = {}) {
  return {
    version: 1,
    selection: { connectionId: c, model: "fixture" },
    idempotencyKey: id(),
    ...extra,
  };
}
function counts() {
  return Object.fromEntries(
    [
      "agents",
      "teams",
      "team_members",
      "handles",
      "conversations",
      "runs",
      "definition_creations",
    ].map((table) => [
      table,
      (db.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n,
    ]),
  );
}

it("upgrades an existing workspace without skipping definitions or memory capture", async () => {
  expect(
    db
      .prepare(
        "SELECT version FROM schema_version WHERE version IN (119,120) ORDER BY version",
      )
      .all(),
  ).toEqual([{ version: 119 }, { version: 120 }]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='memory_sources_capture'",
      )
      .get(),
  ).toBeTruthy();
  expect((await request("/agent-definitions")).status).toBe(200);
});

it("stores original Markdown in Loop, keeps private libraries, and checks edit/delete versions", async () => {
  const markdown = "\uFEFF" + DEFINITION_EXAMPLES.agent.replace(/\n/g, "\r\n");
  const path = `/agent-definitions/${id()}`;
  const before = counts();
  const first = await request(path, { markdown, version: 0 }, "PUT");
  expect(first.status).toBe(200);
  expect(first.data.markdown).toBe(markdown);
  expect(first.data.spec.instructions).toContain("You are a code reviewer.");
  expect(first.data).not.toHaveProperty("owner_id");
  expect(
    (await request(path, { markdown, version: 0 }, "PUT")).data.version,
  ).toBe(1);
  expect(
    (await request("/agent-definitions", undefined, undefined, "bob")).data,
  ).toEqual([]);
  for (const method of ["GET", "PUT", "DELETE"])
    expect(
      (
        await request(
          path,
          method === "GET"
            ? undefined
            : { version: 1, ...(method === "PUT" ? { markdown } : {}) },
          method,
          "bob",
        )
      ).status,
    ).toBe(404);
  const updated = markdown.replace(
    "Do not edit files.",
    "Report only verified findings.",
  );
  expect(
    (await request(path, { markdown: updated, version: 1 }, "PUT")).data
      .version,
  ).toBe(2);
  expect((await request(path, { markdown, version: 1 }, "PUT")).status).toBe(
    409,
  );
  expect((await request(path, { version: 1 }, "DELETE")).status).toBe(409);
  expect((await request(path)).data.markdown).toBe(updated);
  const listed = (await request("/agent-definitions")).data.find(
    (d: any) => d.id === first.data.id,
  );
  expect(listed).not.toHaveProperty("markdown");
  expect(listed.version).toBe(2);
  expect((await request(path, { version: 2 }, "DELETE")).status).toBe(200);
  expect((await request(path)).status).toBe(404);
  expect(counts()).toEqual(before);
});

it.each([
  ["missing frontmatter", "name: reviewer\nReview code."],
  ["missing instructions", "---\nname: reviewer\n---\n"],
  ["duplicate keys", "---\nname: reviewer\nname: another\n---\nReview."],
  ["non-mapping metadata", "---\n- reviewer\n---\nReview."],
  ["invalid handle", "---\nname: Bad Name\n---\nReview."],
  ["reserved handle", "---\nname: loop\n---\nReview."],
  ["tools", "---\nname: reviewer\ntools: Read, Bash\n---\nReview."],
  [
    "permission mode",
    "---\nname: reviewer\npermissionMode: bypassPermissions\n---\nReview.",
  ],
  ["hooks", "---\nname: reviewer\nhooks: {}\n---\nReview."],
  ["custom tag", "---\nname: !execute reviewer\n---\nReview."],
  ["aliases", "---\nname: &name reviewer\ndescription: *name\n---\nReview."],
  [
    "duplicate roles",
    DEFINITION_EXAMPLES.team.replace("feature-reviewer", "feature-lead"),
  ],
  [
    "missing workers",
    DEFINITION_EXAMPLES.team.replace(/members:[\s\S]*?---/, "members: []\n---"),
  ],
  [
    "file references",
    DEFINITION_EXAMPLES.team.replace(
      /members:[\s\S]*?---/,
      "members: [reviewer.md]\n---",
    ),
  ],
  ["too long instructions", "---\nname: reviewer\n---\n" + "x".repeat(12001)],
  [
    "too many bytes",
    "---\nname: reviewer\n---\n" + "🦉".repeat(MAX_DEFINITION_BYTES / 4),
  ],
])(
  "rejects %s without saving or creating anything",
  async (_label, markdown) => {
    const path = `/agent-definitions/${id()}`;
    const before = counts();
    expect((await request(path, { markdown, version: 0 }, "PUT")).status).toBe(
      400,
    );
    expect((await request(path)).status).toBe(404);
    expect(counts()).toEqual(before);
  },
);

it("creates an ordinary agent from a definition and reuses its receipt after edits or deletion", async () => {
  const saved = await save(
    DEFINITION_EXAMPLES.agent.replace("code-reviewer", "markdown-reviewer"),
  );
  const input = creation({ folderId: project });
  const path = `/agent-definitions/${saved.id}/create`;
  const before = counts();
  const result = await request(path, input);
  expect(result.status).toBe(201);
  const agent = result.data.agent;
  expect(agent).toMatchObject({
    name: "markdown-reviewer",
    model: "fixture",
    instructions: saved.spec.instructions,
    folder_id: project,
    connection_id: c,
  });
  expect(counts().runs).toBe(before.runs);
  expect(JSON.stringify(result.data)).not.toContain("private-fixture-secret");
  expect(
    (
      await request(
        `/agents/${agent.id}`,
        { instructions: "Edited in Loop." },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  expect((await request(`/agent-definitions/${saved.id}`)).data.markdown).toBe(
    saved.markdown,
  );
  const after = counts();
  expect((await request(path, input)).data.agent.id).toBe(agent.id);
  expect(
    (await request(path, { ...input, name: "different-name" })).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/agent-definitions/${saved.id}`,
        { version: 1, markdown: saved.markdown + "\nNew guidance." },
        "PUT",
      )
    ).status,
  ).toBe(200);
  expect((await request(path, creation())).status).toBe(409);
  expect(
    (await request(`/agent-definitions/${saved.id}`, { version: 2 }, "DELETE"))
      .status,
  ).toBe(200);
  expect((await request(path, input)).data.agent).toMatchObject({
    id: agent.id,
    instructions: "Edited in Loop.",
  });
  expect(counts()).toEqual(after);
});

it("supports the normal agent form using an imported editable snapshot", async () => {
  const saved = await save();
  const result = await request("/agents", {
    name: "form-markdown-agent",
    connectionId: c,
    model: "fixture",
    instructions: saved.spec.instructions,
    folderId: project,
    idempotencyKey: id(),
  });
  expect(result.status).toBe(201);
  expect(result.data.instructions).toBe(saved.spec.instructions);
  expect(result.data.initialRun).toBeUndefined();
});

it("creates a mixed-connection team with shared and role instructions and rolls back a name collision", async () => {
  const saved = await save(DEFINITION_EXAMPLES.team);
  const otherConnection = connection();
  const input = creation({
    folderId: project,
    roles: {
      "feature-reviewer": { connectionId: otherConnection, effort: "high" },
    },
  });
  const path = `/agent-definitions/${saved.id}/create`;
  const result = await request(path, input);
  expect(result.status).toBe(201);
  const team = result.data.team;
  expect(team.members).toHaveLength(1);
  const manager = db
    .prepare("SELECT * FROM agents WHERE id=?")
    .get(team.manager_id) as any;
  const worker = db
    .prepare("SELECT * FROM agents WHERE id=?")
    .get(team.members[0]) as any;
  expect(manager.connection_id).toBe(c);
  expect(manager.instructions).toBe(saved.spec.manager.instructions);
  expect(manager.instructions).toContain("Follow the project's conventions.");
  expect(worker).toMatchObject({
    connection_id: otherConnection,
    effort: "high",
    folder_id: project,
    instructions: saved.spec.members[0].instructions,
  });
  expect(
    db
      .prepare(
        "SELECT agent_id,project_id,execution_connection_id FROM conversations WHERE id=?",
      )
      .get(team.conversation_id),
  ).toEqual({
    agent_id: manager.id,
    project_id: project,
    execution_connection_id: c,
  });
  const after = counts();
  expect((await request(path, input)).data.team.id).toBe(team.id);
  // A fresh manager would be inserted before the worker's conflicting name.
  expect(
    (
      await request(
        path,
        creation({ roles: { "feature-lead": { name: "another-lead" } } }),
      )
    ).status,
  ).toBe(409);
  expect(counts()).toEqual(after);
  expect((await request(`/teams/${team.id}`, undefined, "DELETE")).status).toBe(
    200,
  );
  expect((await request(path, input)).status).toBe(409);
});

it("refuses foreign resources, unavailable models, stale definitions and unknown roles atomically", async () => {
  const saved = await save(
    DEFINITION_EXAMPLES.team.replaceAll("feature-", "atomic-"),
  );
  const before = counts();
  const path = `/agent-definitions/${saved.id}/create`;
  const attempts: [object, number][] = [
    [{ version: 2 }, 409],
    [{ folderId: folder("bob") }, 404],
    [{ selection: { connectionId: connection("bob"), model: "fixture" } }, 404],
    [{ roles: { "atomic-reviewer": { model: "unavailable" } } }, 400],
    [{ roles: { "atomic-reviewer": { effort: "low" } } }, 400],
    [{ roles: { unknown: { connectionId: c } } }, 400],
  ];
  for (const [extra, status] of attempts) {
    expect((await request(path, creation(extra))).status).toBe(status);
    expect(counts()).toEqual(before);
  }
  expect((await request(path, creation(), undefined, "bob")).status).toBe(404);
  const disconnected = connection();
  db.prepare("UPDATE connections SET status='disconnected' WHERE id=?").run(
    disconnected,
  );
  expect(
    (
      await request(
        path,
        creation({
          roles: { "atomic-reviewer": { connectionId: disconnected } },
        }),
      )
    ).status,
  ).toBe(409);
  expect(counts()).toEqual(before);
});

it("reports a missing or unavailable model before validating effort", async () => {
  const saved = await save("---\nname: missing-model\n---\nReview carefully.");
  const before = counts();
  for (const model of [undefined, "unavailable"]) {
    const result = await request(
      `/agent-definitions/${saved.id}/create`,
      creation({
        selection: { connectionId: c, model, effort: "high" },
      }),
    );
    expect(result.status).toBe(400);
    expect(result.data.error).toContain("Choose an available model");
    expect(counts()).toEqual(before);
  }
});

it("requires reported effort for agent and team definitions, with atomic correction to the default", async () => {
  const connectionId = connection();
  db.prepare("UPDATE connections SET models=? WHERE id=?").run(
    JSON.stringify([{ id: "fixture" }]),
    connectionId,
  );
  const agent = await save(
    "---\nname: effort-not-reported\neffort: high\n---\nReview carefully.",
  );
  const team = await save(
    DEFINITION_EXAMPLES.team.replaceAll("feature-", "effortless-"),
  );
  for (const [definition, role] of [
    [agent, "effort-not-reported"],
    [team, "effortless-reviewer"],
  ] as const) {
    const path = `/agent-definitions/${definition.id}/create`;
    const before = counts();
    const input = creation({
      selection: { connectionId, model: "fixture" },
      roles: { [role]: { effort: "high" } },
    });
    const rejected = await request(path, input);
    expect(rejected.status).toBe(400);
    expect(rejected.data.error).toContain(
      "effort level reported by this model",
    );
    expect(counts()).toEqual(before);
    const corrected = await request(path, {
      ...input,
      roles: { [role]: { effort: null } },
    });
    expect(corrected.status).toBe(201);
    expect(
      db.prepare("SELECT effort FROM agents WHERE name=?").get(role),
    ).toEqual({ effort: null });
  }
});

it("uses a requested model only when available and permits an explicit override", async () => {
  const saved = await save(
    "---\nname: chosen-model\nmodel: sonnet\n---\nReview carefully.",
  );
  const path = `/agent-definitions/${saved.id}/create`;
  expect((await request(path, creation())).status).toBe(400);
  const result = await request(
    path,
    creation({ roles: { "chosen-model": { model: "fixture" } } }),
  );
  expect(result.status).toBe(201);
  expect(result.data.agent.model).toBe("fixture");
  const inherited = await save(
    "---\nname: inherited-model\nmodel: inherit\n---\nReview carefully.",
  );
  expect(
    (await request(`/agent-definitions/${inherited.id}/create`, creation()))
      .data.agent.model,
  ).toBe("fixture");
});

it("validates team size and the combined shared instructions", async () => {
  const manager = "manager:\n  name: bounded-lead\n  instructions: Lead.\n";
  const members = Array.from(
    { length: 9 },
    (_, n) => `  - name: bounded-worker-${n}\n    instructions: Review.\n`,
  ).join("");
  for (const markdown of [
    `---\nkind: team\nname: Too many workers\n${manager}members:\n${members}---\n`,
    DEFINITION_EXAMPLES.team + "x".repeat(12000),
  ]) {
    expect(
      (
        await request(
          `/agent-definitions/${id()}`,
          { markdown, version: 0 },
          "PUT",
        )
      ).status,
    ).toBe(400);
  }
});

it("lets a new worker explicitly choose Workspace instead of inheriting its team project", async () => {
  const teamDefinition = await save(
    DEFINITION_EXAMPLES.team.replaceAll("feature-", "workspace-"),
  );
  const team = (
    await request(
      `/agent-definitions/${teamDefinition.id}/create`,
      creation({ folderId: project }),
    )
  ).data.team;
  const saved = await save(
    DEFINITION_EXAMPLES.agent.replace("code-reviewer", "workspace-import"),
  );
  const worker = await request(
    `/agent-definitions/${saved.id}/create`,
    creation({ teamId: team.id, folderId: null }),
  );
  expect(worker.status).toBe(201);
  expect(worker.data.agent.folder_id).toBeNull();
  expect(worker.data.team.members).toContain(worker.data.agent.id);
});

it("adds workers from agent files and rolls back on team ownership, capacity and fixed-role restrictions", async () => {
  const teamDefinition = await save(
    DEFINITION_EXAMPLES.team.replaceAll("feature-", "membership-"),
  );
  const team = (
    await request(
      `/agent-definitions/${teamDefinition.id}/create`,
      creation({ folderId: project }),
    )
  ).data.team;
  const saved = await save(
    DEFINITION_EXAMPLES.agent.replace("code-reviewer", "new-worker"),
  );
  const path = `/agent-definitions/${saved.id}/create`;
  const input = creation({ teamId: team.id });
  const worker = (await request(path, input)).data.agent;
  expect(worker.folder_id).toBe(project);
  expect((await request(path, input)).data.team.members).toContain(worker.id);
  const before = counts();
  db.prepare("UPDATE teams SET owner_id='bob' WHERE id=?").run(team.id);
  expect(
    (await request(path, creation({ teamId: team.id, name: "foreign-worker" })))
      .status,
  ).toBe(404);
  db.prepare(
    "UPDATE teams SET owner_id='alice',preset_id='code-review' WHERE id=?",
  ).run(team.id);
  expect(
    (
      await request(
        path,
        creation({ teamId: team.id, name: "fixed-role-worker" }),
      )
    ).status,
  ).toBe(409);
  expect(counts()).toEqual(before);
  db.prepare("UPDATE teams SET preset_id=NULL WHERE id=?").run(team.id);
  for (let n = 0; n < 6; n++)
    expect(
      (
        await request(
          path,
          creation({ teamId: team.id, name: `extra-worker-${n}` }),
        )
      ).status,
    ).toBe(201);
  const full = counts();
  expect(
    (await request(path, creation({ teamId: team.id, name: "excess-worker" })))
      .status,
  ).toBe(409);
  expect(counts()).toEqual(full);
  expect((await request(`/teams/${team.id}`, undefined, "DELETE")).status).toBe(
    200,
  );
  expect(
    (
      await request(
        path,
        creation({ teamId: team.id, name: "deleted-team-worker" }),
      )
    ).status,
  ).toBe(404);
  const recovered = await request(path, input);
  expect(recovered.status).toBe(201);
  expect(recovered.data.agent.id).toBe(worker.id);
  expect(recovered.data.team).toBeUndefined();
  expect(counts()).toEqual(full);
});
