import { afterAll, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { modelOptions } from "../runtime/model-options.mjs";
import type { ChatInput } from "../src/server/providers";
import type { Connection } from "../src/shared/types";
const dir = mkdtempSync(join(tmpdir(), "loop-controls-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent, renameAgent } = await import("../src/server/domain");
const { submit, executeAgent } = await import("../src/server/agent-runtime");
const { claim } = await import("../src/server/queue");
const { withTestAdapter } = await import("../src/server/providers");
const { streamConnection } = await import("../src/server/subscriptions");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");
const { teams, createTeam, listTeams } = await import("../src/server/teams");
const { readRunFile, localAttachmentPrompt, uploadFile, attachmentPrompt } =
  await import("../src/server/uploads");
const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use("/api", core, workspace, teams);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const request = async (
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  owner = "alice",
) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      "x-owner": owner,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
};
function connection(provider: string, owner = "alice") {
  const key = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,?,'Fixture',?,'connected',?,?)",
  ).run(
    key,
    owner,
    provider,
    seal("fixture", owner),
    JSON.stringify([
      {
        id: "fixture",
        name: "Fixture",
        effortLevels: [
          { value: "low" },
          { value: "xhigh", description: "Deep work" },
        ],
        defaultEffort: "low",
      },
    ]),
    now(),
  );
  return key;
}
function agent(provider = "openai", owner = "alice") {
  return createAgent(owner, {
    name: "agent-" + id().slice(0, 8),
    connectionId: connection(provider, owner),
    model: "fixture",
  });
}
async function upload(
  name: string,
  bytes: string | Uint8Array,
  options: Record<string, string> = {},
  owner = "alice",
  mime = "text/plain",
) {
  const body = new FormData();
  body.append(
    "file",
    new Blob([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], {
      type: mime,
    }),
    name,
  );
  for (const [key, value] of Object.entries(options)) body.append(key, value);
  const response = await fetch(base + "/uploads", {
    method: "POST",
    headers: { "x-owner": owner },
    body,
  });
  return { status: response.status, data: await response.json() };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("uploads original files, keeps them out of the feed, and reads them only in attached conversations", async () => {
  const a = agent(),
    project = id();
  db.prepare(
    "INSERT INTO folders VALUES(?,'alice',NULL,'project','Uploads',?)",
  ).run(project, now());
  const content = "café notes\n".repeat(4000);
  const { status, data: file } = await upload("notes.txt", content, {
    folderId: project,
    agentId: a.id,
  });
  expect(status).toBe(201);
  expect(file.name).toBe("notes.txt");
  expect(await (await fetch(base + "/objects/" + file.objectId)).text()).toBe(
    content,
  );
  expect(
    (
      await fetch(base + "/objects/" + file.objectId, {
        headers: { "x-owner": "bob" },
      })
    ).status,
  ).toBe(404);
  expect((await request(`/feed?folder=${project}`)).data.items).toEqual([]);
  expect(
    (await request(`/feed?folder=${project}&view=files`)).data.items[0].id,
  ).toBe(file.id);
  expect(
    (await upload("foreign.txt", "x", { folderId: project }, "bob")).status,
  ).toBe(404);
  const run = submit("alice", {
    agentId: a.id,
    input: "Read the file",
    idempotencyKey: id(),
    attachmentIds: [file.id],
  });
  const partial = readRunFile(run, file.id, 0, 4, "utf8");
  const second = readRunFile(run, file.id, partial.nextOffset!, 20, "utf8");
  expect(partial.content + second.content).not.toContain("�");
  expect(partial.nextOffset).toBe(3);
  expect(() =>
    readRunFile({ ...run, conversation_id: id() }, file.id, 0, 100, "utf8"),
  ).toThrow("not attached");
  const requestKey = (
    db.prepare("SELECT idempotency_key FROM runs WHERE id=?").get(run.id) as {
      idempotency_key: string;
    }
  ).idempotency_key;
  expect(() =>
    submit("alice", {
      agentId: a.id,
      input: run.input,
      idempotencyKey: requestKey,
      attachmentIds: [],
    }),
  ).toThrow("different work");
  const bob = agent("openai", "bob");
  expect(() =>
    submit("bob", {
      agentId: bob.id,
      input: "Read",
      idempotencyKey: id(),
      attachmentIds: [file.id],
    }),
  ).toThrow("Item not found");
  const live = claim("uploads-test")!;
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream(_key, input) {
      const result = input.messages.find((message) => message.role === "tool");
      if (!result) {
        expect(input.messages[0].content).toContain(file.id);
        yield {
          toolCall: {
            id: "read",
            name: "loop_read_file",
            arguments: { fileId: file.id, length: 100 },
          },
        };
      } else {
        expect(result.content).toContain("café notes");
        yield { text: "Read the uploaded notes." };
      }
    },
  });
  try {
    expect(await executeAgent(live)).toBe(true);
  } finally {
    restore();
  }
  expect(
    db.prepare("SELECT count(*) n FROM approvals WHERE run_id=?").get(run.id),
  ).toEqual({ n: 0 });
  expect(
    (await request(`/conversations/${run.conversation_id}`)).data.messages[0]
      .metadata,
  ).toContain(file.id);
  const binary = await upload(
    "image.bin",
    new Uint8Array([0, 255, 2]),
    {},
    "alice",
    "application/octet-stream",
  );
  const next = submit("alice", {
    agentId: a.id,
    input: "Read binary",
    idempotencyKey: id(),
    attachmentIds: [binary.data.id],
  });
  expect(readRunFile(next, binary.data.id, 0, 3, "base64").content).toBe(
    "AP8C",
  );
  expect(() => readRunFile(next, binary.data.id, 0, 3, "utf8")).toThrow(
    "binary",
  );
  const prompt = localAttachmentPrompt("alice", "Inspect", [binary.data]);
  const files = JSON.parse(prompt.split("\n").at(-1)!);
  expect(readFileSync(files[0].path)).toEqual(Buffer.from([0, 255, 2]));
});

for (const provider of ["openai", "anthropic"] as const)
  it.each(["text/plain", "image/png", "application/pdf"])(
    `${provider}: archived %s attachments remain readable without breaking follow-ups`,
    async (mime) => {
      const a = agent(provider);
      const file = uploadFile("alice", {
        originalname: "original-file",
        mimetype: mime,
        buffer: Buffer.from("Original contents"),
      });
      const inputs: ChatInput[] = [];
      const restore = withTestAdapter(provider, {
        async models() {
          return [];
        },
        async *stream(_key, input) {
          inputs.push(input);
          yield { text: "Reply still works." };
        },
      });
      try {
        const first = submit("alice", {
          agentId: a.id,
          input: "Read this file",
          idempotencyKey: id(),
          attachmentIds: [file.id],
        });
        expect(await executeAgent(first)).toBe(true);
        expect(
          (
            await request(
              `/artifacts/${file.id}`,
              { archived: true, version: 1 },
              "PATCH",
            )
          ).status,
        ).toBe(200);
        const next = submit("alice", {
          agentId: a.id,
          conversationId: first.conversation_id!,
          input: "Just say hello",
          idempotencyKey: id(),
        });
        expect(await executeAgent(next)).toBe(true);
        expect(inputs).toHaveLength(2);
        expect(inputs[1].messages[0].attachments?.[0].id).toBe(file.id);
        expect(
          inputs[1].messages.flatMap((message) => message.files || []),
        ).toEqual([]);
        expect(readRunFile(next, file.id, 0, 100, "utf8").content).toBe(
          "Original contents",
        );
        expect(() =>
          readRunFile({ ...next, owner_id: "bob" }, file.id, 0, 100, "utf8"),
        ).toThrow("not attached");
        const local = JSON.parse(
          localAttachmentPrompt("alice", "Read", [file]).split("\n").at(-1)!,
        );
        expect(readFileSync(local[0].path, "utf8")).toBe("Original contents");
        expect(
          (await request("/feed?view=files")).data.items.some(
            (item: any) => item.id === file.id,
          ),
        ).toBe(false);
      } finally {
        restore();
      }
    },
  );

it("retries a failed API run after its attachment is archived", async () => {
  const a = agent("anthropic");
  const file = uploadFile("alice", {
    originalname: "photo.png",
    mimetype: "image/png",
    buffer: Buffer.from([0, 1, 255]),
  });
  const first = submit("alice", {
    agentId: a.id,
    input: "Inspect the photo",
    idempotencyKey: id(),
    attachmentIds: [file.id],
  });
  let attempts = 0;
  const restore = withTestAdapter("anthropic", {
    async models() {
      return [];
    },
    async *stream(_key, input) {
      if (++attempts === 1) throw new Error("Fixture provider failure");
      expect(input.messages.flatMap((message) => message.files || [])).toEqual([
        { name: "photo.png", mime: "image/png", data: "AAH/" },
      ]);
      yield { text: "Retry completed." };
    },
  });
  try {
    await expect(executeAgent(first)).rejects.toThrow(
      "Fixture provider failure",
    );
    // The worker records a provider failure before offering Retry.
    db.prepare("UPDATE runs SET state='failed' WHERE id=?").run(first.id);
    expect(
      (
        await request(
          `/artifacts/${file.id}`,
          { archived: true, version: 1 },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    const retry = await request(`/runs/${first.id}/retry`, {
      idempotencyKey: id(),
    });
    expect(retry.status).toBe(200);
    expect(await executeAgent(retry.data)).toBe(true);
    expect(attempts).toBe(2);
  } finally {
    restore();
  }
});

it("bounds API attachment payloads and keeps oversized files available through file reads", async () => {
  const a = agent("anthropic");
  const stored = (name: string, mime: string, size: number) =>
    uploadFile("alice", {
      originalname: name,
      mimetype: mime,
      buffer: Buffer.alloc(size, 0),
    });
  const old = stored("previous.png", "image/png", 100);
  const files = [
    stored("large.pdf", "application/pdf", 25 * 1024 * 1024),
    stored("large.png", "image/png", 8 * 1024 * 1024),
    ...Array.from({ length: 6 }, (_, i) =>
      stored(`photo-${i}.png`, "image/png", 3_000_000),
    ),
  ];
  const run = submit("alice", {
    agentId: a.id,
    input: "Read the files",
    idempotencyKey: id(),
    attachmentIds: files.map((file) => file.id),
  });
  const input: ChatInput = {
    model: "fixture",
    instructions: "Inspect the attachments",
    signal: new AbortController().signal,
    messages: [
      {
        role: "user",
        content: attachmentPrompt("Earlier image", [old]),
        attachments: [old],
      },
      { role: "assistant", content: "Earlier answer" },
      {
        role: "user",
        content: attachmentPrompt(run.input, files),
        attachments: files,
      },
    ],
  };
  const restore = withTestAdapter("anthropic", {
    async models() {
      return [];
    },
    async *stream(_key, prepared) {
      expect(prepared.messages[0].files).toBeUndefined();
      const current = prepared.messages.at(-1)!;
      expect(current.files!.length).toBeGreaterThan(0);
      expect(current.files!.length).toBeLessThan(6);
      expect(
        current.files!.every((file) => file.data.length <= 5_000_000),
      ).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(prepared))).toBeLessThan(
        32_000_000,
      );
      for (const file of files.slice(0, 2)) {
        expect(current.files!.some((inline) => inline.name === file.name)).toBe(
          false,
        );
        expect(current.content).toContain(file.id);
        expect(readRunFile(run, file.id, 0, 3, "base64").content).toBe("AAAA");
      }
      expect(current.content).toContain("not included as inline image/PDF");
      yield { text: "Files handled without an oversized request." };
    },
  });
  try {
    const connection = db
      .prepare("SELECT * FROM connections WHERE id=?")
      .get(a.connection_id) as Connection;
    const chunks = [];
    for await (const chunk of streamConnection(connection, input))
      chunks.push(chunk);
    expect(chunks).toEqual([
      { text: "Files handled without an oversized request." },
    ]);
    expect(input.messages.every((message) => !message.files)).toBe(true);
    expect(input.messages.at(-1)!.content).not.toContain(
      "not included as inline",
    );
  } finally {
    restore();
  }
});

it("deletes a team without deleting agents, history, or active work", async () => {
  const manager = agent(),
    worker = agent();
  const team = createTeam("alice", {
    name: "Review team",
    managerId: manager.id,
    members: [worker.id],
  });
  const active = submit("alice", {
    agentId: manager.id,
    input: "Review",
    idempotencyKey: id(),
  });
  expect(
    (await request(`/teams/${team.id}`, undefined, "DELETE", "bob")).status,
  ).toBe(404);
  expect((await request(`/teams/${team.id}`, undefined, "DELETE")).status).toBe(
    200,
  );
  expect((await request(`/teams/${team.id}`, undefined, "DELETE")).status).toBe(
    200,
  );
  expect(listTeams("alice").some((t) => t.id === team.id)).toBe(false);
  expect(
    db
      .prepare("SELECT team_id FROM conversations WHERE id=?")
      .get(team.conversation_id),
  ).toEqual({ team_id: null });
  expect(
    db.prepare("SELECT state FROM runs WHERE id=?").get(active.id),
  ).toEqual({ state: "queued" });
  expect(
    db
      .prepare("SELECT count(*) n FROM agents WHERE id IN (?,?)")
      .get(manager.id, worker.id),
  ).toEqual({ n: 2 });
  const fresh = submit("alice", {
    agentId: manager.id,
    input: "Independent task",
    idempotencyKey: id(),
  });
  expect(fresh.conversation_id).not.toBe(team.conversation_id);
  expect((await request(`/feed?teams=${team.id}`)).status).toBe(404);
});

it("changes provider, model, and supported effort atomically while preserving queued snapshots", async () => {
  const a = agent(),
    team = createTeam("alice", {
      name: "Model changes",
      managerId: a.id,
      members: [agent().id],
    });
  const run = submit("alice", {
    agentId: a.id,
    input: "Original settings",
    idempotencyKey: id(),
  });
  const target = connection("anthropic");
  expect(
    (
      await request(
        `/agents/${a.id}`,
        { connectionId: target, model: "fixture", effort: "xhigh" },
        "PATCH",
      )
    ).data,
  ).toMatchObject({
    provider: "anthropic",
    connection_id: target,
    effort: "xhigh",
  });
  expect(
    JSON.parse(
      (db.prepare("SELECT payload FROM runs WHERE id=?").get(run.id) as any)
        .payload,
    ).connectionId,
  ).toBe(a.connection_id);
  expect(() =>
    submit("alice", {
      agentId: a.id,
      conversationId: run.conversation_id!,
      input: "Old conversation",
      idempotencyKey: id(),
    }),
  ).toThrow("Start a new conversation");
  const fresh = submit("alice", {
    agentId: a.id,
    input: "Use new provider",
    idempotencyKey: id(),
  });
  expect(fresh.conversation_id).not.toBe(run.conversation_id);
  expect(
    db.prepare("SELECT conversation_id FROM teams WHERE id=?").get(team.id),
  ).toEqual({ conversation_id: fresh.conversation_id });
  expect(JSON.parse(fresh.payload)).toMatchObject({
    connectionId: target,
    effort: "xhigh",
    teamId: team.id,
  });
  expect(
    (await request(`/agents/${a.id}`, { effort: "ultra" }, "PATCH")).status,
  ).toBe(400);
  expect(
    (
      await request(
        `/agents/${a.id}`,
        { connectionId: connection("openai", "bob"), effort: null },
        "PATCH",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        `/agents/${a.id}`,
        { connectionId: a.connection_id, model: "missing" },
        "PATCH",
      )
    ).status,
  ).toBe(400);
  expect(
    db.prepare("SELECT connection_id,effort FROM agents WHERE id=?").get(a.id),
  ).toEqual({ connection_id: target, effort: "xhigh" });
  const restore = withTestAdapter("anthropic", {
    async models() {
      return [
        {
          id: "new",
          name: "New",
          capabilities: "Native fixture",
          ...modelOptions({
            supportedEffortLevels: ["low", "max"],
            resolvedModel: "claude-opus-5-5",
          }),
        },
      ];
    },
    async *stream() {},
  });
  try {
    const models = (await request(`/connections/${target}/models`)).data.models;
    expect(models[0]).toMatchObject({
      effortLevels: [{ value: "low" }, { value: "max" }],
      resolvedModel: "claude-opus-5-5",
    });
    expect(
      JSON.parse(
        (
          db
            .prepare("SELECT models FROM connections WHERE id=?")
            .get(target) as Connection
        ).models,
      ),
    ).toEqual(models);
  } finally {
    restore();
  }
  expect(
    modelOptions({
      supportedReasoningEfforts: [
        { reasoningEffort: "xhigh", description: "Thorough" },
      ],
      defaultReasoningEffort: "xhigh",
    }),
  ).toEqual({
    effortLevels: [{ value: "xhigh", description: "Thorough" }],
    defaultEffort: "xhigh",
  });
  expect(modelOptions({})).toEqual({});
  for (const resolvedModel of [null, 42, "  ", "x".repeat(201)])
    expect(modelOptions({ resolvedModel })).toEqual({});
});

it("suggests available single-word names across owners and retained handles, even after the word list is used", async () => {
  const connectionId = connection("openai", "names");
  const occupied = new Set(
    (db.prepare("SELECT name FROM handles").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  for (let i = 0; i < 200; i++) {
    const suggestion = await request("/agents/suggest-name");
    expect(suggestion.status).toBe(200);
    const { name } = suggestion.data;
    expect(name).toMatch(/^[a-z]{3,32}$/);
    expect(occupied.has(name)).toBe(false);
    const created = createAgent("names", {
      name,
      connectionId,
      model: "fixture",
    });
    occupied.add(name);
    if (i === 0) renameAgent("names", created.id, "renamed-suggestion");
  }
});
