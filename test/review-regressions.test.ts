import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop-review-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { seal } = await import("../src/server/secrets");
const { createAgent } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { withTestAdapter } = await import("../src/server/providers");
const { tick, execute } = await import("../src/server/worker");
const { workspace } = await import("../src/server/workspace-routes");
const app = express();
app.use(express.json(), (_req, res, next) => {
  res.locals.owner = "alice";
  next();
});
app.use(workspace);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;
function agent(provider: "openai" | "anthropic") {
  const c = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,'alice',?,'Fixture',?,'connected',?,?)",
  ).run(
    c,
    provider,
    seal("fixture", "alice"),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  return createAgent("alice", {
    name: "review-" + id().slice(0, 8),
    connectionId: c,
    model: "fixture",
  });
}
const status = (c: string | null) =>
  (db.prepare("SELECT status FROM connections WHERE id=?").get(c) as any)
    .status;
const record = (r: string) =>
  db.prepare("SELECT * FROM runs WHERE id=?").get(r) as any;
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("keeps live user edits and their versions while the generator finishes its own revision", async () => {
  const a = agent("openai");
  const run = submit("alice", {
    agentId: a.id,
    input: "Draft",
    idempotencyKey: id(),
  });
  const artifact = () =>
    db.prepare("SELECT * FROM artifacts WHERE run_id=?").get(run.id) as any;
  const patch = (data: object) =>
    fetch(base + "/artifacts/" + artifact().id, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  const restore = withTestAdapter("openai", {
    async models() {
      return [];
    },
    async *stream() {
      yield { text: "First " };
      expect((await patch({ pinned: true, version: 1 })).status).toBe(200);
      yield { text: "second " };
      await expect
        .poll(artifact, { timeout: 2000, interval: 10 })
        .toMatchObject({
          content: "First second ",
          pinned: 1,
          version: 2,
        });
      expect(
        (await patch({ content: "My saved edit", version: 2 })).status,
      ).toBe(200);
      expect(
        (await patch({ content: "Stale overwrite", version: 2 })).status,
      ).toBe(409);
      yield { text: "third." };
    },
  });
  try {
    await tick(execute);
    expect(record(run.id).state).toBe("completed");
    expect(artifact()).toMatchObject({
      content: "My saved edit",
      pinned: 1,
      version: 3,
    });
    expect(JSON.parse(artifact().metadata)).toMatchObject({ edited: true });
    // Completion indexes the user's saved revision, not the generator's text.
    expect(
      db
        .prepare("SELECT content FROM search_fts WHERE id=?")
        .get("artifact:" + artifact().id),
    ).toEqual({ content: "My saved edit" });
    expect(
      db
        .prepare("SELECT content FROM search_documents WHERE id=?")
        .get("artifact:" + artifact().id),
    ).toEqual({ content: "My saved edit" });
    expect(
      db
        .prepare(
          "SELECT version,content FROM artifact_versions WHERE artifact_id=? ORDER BY version",
        )
        .all(artifact().id),
    ).toEqual([
      { version: 1, content: "First second third." },
      { version: 3, content: "My saved edit" },
    ]);
    expect(
      db
        .prepare(
          "SELECT content FROM messages WHERE run_id=? AND role='assistant'",
        )
        .get(run.id),
    ).toEqual({ content: "First second third." });
  } finally {
    restore();
  }
});
it.each([401, 403])(
  "still invalidates provider credentials for a provider %s",
  async (code) => {
    const a = agent("openai");
    const run = submit("alice", {
      agentId: a.id,
      input: "Auth failure",
      idempotencyKey: id(),
    });
    const restore = withTestAdapter("openai", {
      async models() {
        return [];
      },
      async *stream() {
        throw Object.assign(new Error("Provider rejected credential"), {
          status: code,
        });
      },
    });
    try {
      await tick(execute);
      expect(record(run.id).state).toBe("failed");
      expect(status(a.connection_id)).toBe("needs_reconnect");
    } finally {
      restore();
    }
  },
);
it("retries an early Anthropic 529 in the same conversation without an empty assistant placeholder", async () => {
  const a = agent("anthropic");
  const first = submit("alice", {
    agentId: a.id,
    input: "First question",
    idempotencyKey: id(),
  });
  const bodies: any[] = [];
  vi.stubGlobal("fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1)
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: "Fixture overload" },
        }),
        { status: 529, headers: { "content-type": "application/json" } },
      );
    return new Response(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Recovered"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    await tick(execute);
    expect(record(first.id).state).toBe("failed");
    expect(status(a.connection_id)).toBe("connected");
    const retry = submit("alice", {
      agentId: a.id,
      conversationId: first.conversation_id!,
      input: "Try again",
      idempotencyKey: id(),
    });
    await tick(execute);
    expect(record(retry.id)).toMatchObject({
      state: "completed",
      result: "Recovered",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages).toEqual([
      { role: "user", content: [{ type: "text", text: "First question" }] },
      { role: "user", content: [{ type: "text", text: "Try again" }] },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
