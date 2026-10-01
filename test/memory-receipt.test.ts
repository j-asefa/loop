import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
const dir = mkdtempSync(join(tmpdir(), "loop-memory-receipt-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db");
const { createAgent, Problem } = await import("../src/server/domain");
const { memoryRoutes } = await import("../src/server/memory");
const { memoryReceiptText } = await import("../src/client/Memory");

const app = express();
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use("/api", memoryRoutes);
app.use((e: any, _req: any, res: any, _next: any) =>
  res.status(e instanceof Problem ? e.status : 500).json({ error: e.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
async function receipt(owner: string, runId: string) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api/runs/${runId}/memory`,
    { headers: { "x-owner": owner } },
  );
  return { status: response.status, data: (await response.json()) as any };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runFor(owner: string) {
  const connectionId = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,'{}',?)",
  ).run(connectionId, owner, JSON.stringify([{ id: "fixture" }]), now());
  const agent = createAgent(owner, {
    name: "m-" + randomBytes(6).toString("hex"),
    connectionId,
    model: "fixture",
  });
  const cid = id(),
    rid = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
  ).run(cid, owner, agent.id, "Topic", now());
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    rid,
    owner,
    agent.id,
    cid,
    "prompt",
    "completed",
    rid,
    "{}",
    now(),
    now(),
  );
  return rid;
}

it("says no memory was added to a run that never recalled any", async () => {
  const owner = id();
  const rid = runFor(owner);
  const { status, data } = await receipt(owner, rid);
  expect(status).toBe(200);
  expect(data).toEqual({ mode: "not-used", sources: "[]", tokens: 0 });
  expect(memoryReceiptText(data)).toBe(
    "No saved memory was added to this message.",
  );
  // Another owner's run behaves as missing.
  expect((await receipt(id(), rid)).status).toBe(404);
});

it("reports the recorded sources and the added memory's size", async () => {
  const owner = id();
  const rid = runFor(owner);
  const sources = [
    { id: "a", title: "Plan", role: "note", revision: 1 },
    { id: "b", title: "Notes", role: "note", revision: 2 },
  ];
  db.prepare("INSERT INTO memory_receipts VALUES(?,?,?,?,?)").run(
    rid,
    "lexical-degraded",
    JSON.stringify(sources),
    980,
    now(),
  );
  const { data } = await receipt(owner, rid);
  expect(memoryReceiptText(data)).toBe(
    "Added 2 saved sources, about 980 tokens of context. Matched by keyword only: memory search was unavailable.",
  );
});

it("tells an empty search apart from memory being off", () => {
  expect(
    memoryReceiptText({ mode: "semantic", sources: "[]", tokens: 0 }),
  ).toBe("No saved memory matched this message.");
  expect(
    memoryReceiptText({ mode: "disabled", sources: "[]", tokens: 0 }),
  ).toBe("Memory is turned off here, so none was added.");
  expect(
    memoryReceiptText({
      mode: "semantic",
      sources: JSON.stringify([{ id: "a" }]),
      tokens: 1,
    }),
  ).toBe("Added 1 saved source, about 1 token of context.");
});
