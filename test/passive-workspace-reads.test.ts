import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import express from "express";
import { withPassiveWorkspaceRead } from "../src/server/workspace-read-context.js";
import { gitProject } from "./git-project.js";
import { Codex } from "../src/adapters/codex.js";
import { Pi } from "../src/adapters/pi.js";
import { OpenCode } from "../src/adapters/opencode.js";
import { DirectControls } from "../src/adapters/direct-controls.js";
import { NativeOutput } from "../src/server/native-output.js";
import type { Live } from "../src/server/native-sessions.js";

const root = mkdtempSync(join(tmpdir(), "loop55-passive-reads-"));
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_DATA_DIR = join(root, "data");
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.LOOP55_TEST_HARNESS = "claude";
gitProject(root);
const { db } = await import("../src/server/db.js");
const { seal } = await import("../src/server/secrets.js");
const { core } = await import("../src/server/core-routes.js");
const { workspace } = await import("../src/server/workspace-routes.js");
const { companion } = await import("../src/server/companion-routes.js");
const { mountRoutes } = await import("../src/server/registrar.js");
const {
  executionClient,
  executionRequest,
  setExecutionTransport,
  closeExecution,
} = await import("../src/server/execution-client.js");
const { runtimeList } =
  await import("../src/server/execution-runtime-actions.js");
const { nativeSessions } = await import("../src/server/native-sessions.js");
const { agentWorkspace } = await import("../src/server/agent-worktree.js");
const { withTestAdapter } = await import("../src/server/providers.js");
const hostControl = await import("../src/host-control.js");
const restoreProvider = withTestAdapter("openai", {
  async models() {
    return [{ id: "fixture", name: "Fixture", capabilities: "text" }];
  },
  async *stream() {},
});
const owner = "local-workspace",
  generation = randomUUID(),
  native = randomUUID(),
  api = randomUUID(),
  foreign = randomUUID(),
  agent = randomUUID();
const models = [{ id: "stored-model", name: "Stored model" }];
for (const [id, accountOwner, metadata] of [
  [native, owner, { loop55Harness: "claude" }],
  [api, owner, {}],
  [foreign, "someone-else", {}],
] as const)
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?,0)",
  ).run(
    id,
    accountOwner,
    seal("fixture", accountOwner),
    JSON.stringify(models),
    JSON.stringify(metadata),
  );
db.prepare(
  "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,connection_id,origin,created_at) VALUES(?,?,'Fixture','fixture','openai','stored-model','',?,'loop55',0)",
).run(agent, owner, native);
db.prepare("INSERT INTO harnesses VALUES('claude',?,'{}','{}','[]',0)").run(
  JSON.stringify({
    harness: "claude",
    executable: resolve("test/harness.mjs"),
    project: root,
    version: "fixture",
    billing: "existing",
  }),
);
let passive = true,
  scopeOwner = owner,
  base = "";
const sent: { method: string; input: unknown }[] = [];
setExecutionTransport({
  status: () => ({ v: 1, generation, state: "ready" }),
  async send(request) {
    sent.push({ method: request.method, input: request.input });
    let result;
    if (request.method === "runtime.list")
      result = await runtimeList(
        request.input as Parameters<typeof runtimeList>[0],
      );
    else if (request.method === "native.catalog") {
      const input = request.input as {
        cachedOnly?: boolean;
        conversationId?: string;
      };
      result = await nativeSessions.catalog(
        { id: agent, connection_id: native, folder_id: null },
        input.conversationId,
        input.cachedOnly,
      );
    } else if (request.method === "native.controls") {
      const input = request.input as {
        conversationId: string;
        cachedOnly?: boolean;
      };
      result = nativeSessions.controls(input.conversationId, input.cachedOnly);
    } else throw new Error("Unexpected native effect: " + request.method);
    return { v: 1, requestId: request.requestId, generation, ok: true, result };
  },
});
const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.locals.owner = owner;
  if (passive) withPassiveWorkspaceRead(scopeOwner, () => next());
  else next();
});
for (const routes of [core, workspace, companion])
  mountRoutes(app, routes, "/api");
app.use(((error, _req, res, _next) =>
  res
    .status(error.status ?? 500)
    .json({ error: error.message })) as express.ErrorRequestHandler);
const server = createServer(app);
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  restoreProvider();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.LOOP55_TEST_HARNESS;
});
async function get(path: string, headers?: Record<string, string>) {
  const response = await fetch(base + path, { headers });
  return { status: response.status, body: await response.json() };
}
it("passive bootstrap and folder reads do not create a default project", async () => {
  expect(db.prepare("SELECT count(*) n FROM folders").get()).toEqual({ n: 0 });
  expect((await get("/bootstrap")).status).toBe(200);
  expect((await get("/folders")).status).toBe(200);
  expect(db.prepare("SELECT count(*) n FROM folders").get()).toEqual({ n: 0 });
});
it.each([
  ["native", native],
  ["API", api],
])(
  "a passive %s model read returns stored models without contacting its provider",
  async (_kind, id) => {
    const before = sent.length;
    const restore = withTestAdapter("openai", {
      async models() {
        throw new Error("Unexpected model refresh");
      },
      async *stream() {
        throw new Error("Unexpected inference");
      },
    });
    try {
      expect(await get(`/connections/${id}/models`)).toEqual({
        status: 200,
        body: { models },
      });
      expect(sent.length).toBe(before);
    } finally {
      restore();
    }
  },
);
it("passive model reads still enforce owner isolation", async () => {
  expect((await get(`/connections/${foreign}/models`)).status).toBe(404);
  scopeOwner = "someone-else";
  try {
    expect((await get(`/connections/${api}/models`)).status).toBe(403);
  } finally {
    scopeOwner = owner;
  }
});
it("local model reads still refresh and request headers cannot select passive mode", async () => {
  passive = false;
  let refreshes = 0;
  const updated = [
    { id: "updated-model", name: "Updated model", capabilities: "text" },
  ];
  const restore = withTestAdapter("openai", {
    async models() {
      refreshes++;
      return updated;
    },
    async *stream() {},
  });
  try {
    expect(
      await get(`/connections/${api}/models`, { "x-loop55-passive-read": "1" }),
    ).toEqual({ status: 200, body: { models: updated } });
    expect(refreshes).toBe(1);
  } finally {
    restore();
    passive = true;
  }
});
it("passive runtime discovery uses registrations without running discovery probes", async () => {
  const discover = vi
    .spyOn(hostControl, "discover")
    .mockRejectedValue(new Error("Unexpected discovery probe"));
  try {
    const result = await get("/workspace/runtimes?fresh=1");
    expect(result.status).toBe(200);
    expect(result.body.runtimes).toContainEqual(
      expect.objectContaining({ name: "claude", version: "fixture" }),
    );
    expect(discover).not.toHaveBeenCalled();
    expect(sent.at(-1)?.input).toMatchObject({ fresh: true, cachedOnly: true });
  } finally {
    discover.mockRestore();
  }
});
it("passive command discovery never launches a missing catalog but can read a loaded catalog", async () => {
  expect((await get(`/agents/${agent}/harness`)).body).toMatchObject({
    available: false,
    commands: [],
  });
  expect(sent.at(-1)?.input).toMatchObject({ cachedOnly: true });
  passive = false;
  try {
    expect((await get(`/agents/${agent}/harness`)).body.available).toBe(true);
  } finally {
    passive = true;
  }
  expect((await get(`/agents/${agent}/harness`)).body.available).toBe(true);
});
it.each([
  { harness: "codex", Adapter: Codex },
  { harness: "pi", Adapter: Pi },
  { harness: "opencode", Adapter: OpenCode },
] as const)(
  "passive live $harness catalogs and controls do not refresh the harness",
  async ({ harness, Adapter }) => {
    const conversation = randomUUID(),
      liveGeneration = randomUUID();
    const project = agentWorkspace(root, root, {
      ownerId: owner,
      agentId: agent,
      environmentId: process.env.LOOP55_DATA_DIR!,
      projectId: root,
    });
    const options = {
      harness,
      executable: "fixture-unused",
      project: root,
      version: "fixture",
      billing: "existing" as const,
    };
    db.prepare("INSERT INTO harnesses VALUES(?,?,'{}','[]','{}',0)").run(
      harness,
      JSON.stringify(options),
    );
    db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
      JSON.stringify({ loop55Harness: harness }),
      native,
    );
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Loaded session',0)",
    ).run(conversation, owner, agent);
    db.prepare(
      "INSERT INTO companion_sessions(conversation_id,harness,project,worktree_source,worktree_agent_id,generation,state,updated_at) VALUES(?,?,?,?,?,?,'idle',0)",
    ).run(
      conversation,
      harness,
      project.directory,
      project.worktreeSource,
      agent,
      liveGeneration,
    );
    const emitted: unknown[] = [];
    const adapter = new Adapter(
      { ...options, project: project.directory },
      (event) => emitted.push(event),
    );
    adapter.commands = [
      {
        name: "Loaded",
        token: "/loaded",
        kind: "command",
        description: "Loaded fixture command",
      },
    ];
    const controls = new DirectControls(harness, (event) =>
      emitted.push(event),
    );
    controls.publish([], adapter.commands);
    Reflect.set(adapter, "controlState", controls);
    const calls: string[] = [];
    Reflect.set(adapter, "native", {
      async request(method: string) {
        calls.push(method);
        return harness === "codex"
          ? {
              data: [
                {
                  skills: [
                    {
                      name: "fresh",
                      enabled: true,
                      path: join(project.directory, "skill.md"),
                    },
                  ],
                },
              ],
            }
          : { commands: [{ name: "fresh", source: "command" }] };
      },
    });
    Reflect.set(adapter, "thread", "fixture-thread");
    Reflect.set(adapter, "origin", "http://fixture.invalid");
    Reflect.set(adapter, "session", "fixture-session");
    Reflect.set(adapter, "api", async (path: string) => {
      calls.push(path);
      return [{ name: "fresh" }];
    });
    const live: Live = {
      adapter,
      generation: liveGeneration,
      binding: {
        conversation_id: conversation,
        harness,
        native_id: null,
        project: project.directory,
        worktree_source: project.worktreeSource,
        worktree_agent_id: agent,
        model: null,
        instructions: "",
        generation: liveGeneration,
        state: "idle",
      },
      ready: Promise.resolve(),
      bootstrapRun: undefined as never,
      items: new NativeOutput(),
      requests: new Map(),
      closed: false,
      cancelling: false,
      waiting: false,
      bridgeWaiting: 0,
    };
    const sessions = Reflect.get(nativeSessions, "live") as Map<string, Live>;
    sessions.set(conversation, live);
    emitted.length = 0;
    try {
      const catalog = await get(
        `/agents/${agent}/harness?conversation=${conversation}`,
      );
      expect(catalog.status).toBe(200);
      expect(catalog.body.commands).toContainEqual(
        expect.objectContaining({ name: "Loaded" }),
      );
      expect(sent.at(-1)?.input).toMatchObject({ cachedOnly: true });
      const settings = await get(`/conversations/${conversation}/settings`);
      expect(settings.status).toBe(200);
      expect(settings.body.commands.commands).toContainEqual(
        expect.objectContaining({ name: "Loaded" }),
      );
      expect(sent.at(-1)?.input).toMatchObject({ cachedOnly: true });
      expect(calls).toEqual([]);
      expect(emitted).toEqual([]);
      passive = false;
      expect(
        (await get(`/agents/${agent}/harness?conversation=${conversation}`))
          .status,
      ).toBe(200);
      await expect.poll(() => calls.length).toBe(1);
      await expect.poll(() => adapter.commands[0]?.name).toBe("fresh");
      expect(emitted.length).toBeGreaterThan(0);
    } finally {
      passive = true;
      sessions.delete(conversation);
      db.prepare("DELETE FROM companion_sessions WHERE conversation_id=?").run(
        conversation,
      );
      db.prepare("DELETE FROM conversations WHERE id=?").run(conversation);
      db.prepare("DELETE FROM harnesses WHERE name=?").run(harness);
      db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
        JSON.stringify({ loop55Harness: "claude" }),
        native,
      );
    }
  },
);

it("passive inspection refuses native effects before transport even through the direct client", async () => {
  const before = sent.length;
  for (const invoke of [
    () => executionRequest("runtime.refresh", { connectionId: native }),
    () => executionClient.request("runtime.refresh", { connectionId: native }),
  ])
    await expect(withPassiveWorkspaceRead(owner, invoke)).rejects.toMatchObject(
      { status: 403 },
    );
  expect(sent.length).toBe(before);
});
