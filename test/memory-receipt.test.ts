import { seedConnection } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";

import { randomBytes } from "node:crypto";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { memoryRoutes } = await import("../src/server/memory");
const { memoryReceiptText } = await import("../src/client/Memory");

const app = await productionApp(undefined, [memoryRoutes], {
  ownerHeader: "x-owner",
  json: false,
});
async function receipt(owner: string, runId: string) {
  const response = await fetch(`${app.url}/api/runs/${runId}/memory`, {
    headers: { "x-owner": owner },
  });
  return { status: response.status, data: (await response.json()) as any };
}
afterAll(async () => {
  await app.close();
  db.close();
});

function runFor(owner: string) {
  const connectionId = id();
  seedConnection(db, {
    id: connectionId,
    owner_id: owner,
    secret: "",
    models: JSON.stringify([{ id: "fixture" }]),
    created_at: now(),
  });
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
    "lexical",
    JSON.stringify(sources),
    980,
    now(),
  );
  const { data } = await receipt(owner, rid);
  expect(memoryReceiptText(data)).toBe(
    "Added 2 saved sources, about 980 tokens of context.",
  );
});

it("tells an empty search apart from memory being off", () => {
  expect(memoryReceiptText({ mode: "lexical", sources: "[]", tokens: 0 })).toBe(
    "No saved memory matched this message.",
  );
  expect(
    memoryReceiptText({ mode: "disabled", sources: "[]", tokens: 0 }),
  ).toBe("Memory is turned off here, so none was added.");
  expect(
    memoryReceiptText({
      mode: "lexical",
      sources: JSON.stringify([{ id: "a" }]),
      tokens: 1,
    }),
  ).toBe("Added 1 saved source, about 1 token of context.");
});

it("reports conversation memory policy and isolates owners", async () => {
  const owner = id(),
    rid = runFor(owner);
  const { conversation_id: conversation } = db
    .prepare("SELECT conversation_id FROM runs WHERE id=?")
    .get(rid) as { conversation_id: string };
  const url = `${app.url}/api/conversations/${conversation}/memory`;
  const get = (who: string) => fetch(url, { headers: { "x-owner": who } });
  expect(await (await get(owner)).json()).toEqual({ memoryIncluded: false });
  expect((await get(id())).status).toBe(404);
  db.prepare(
    "INSERT INTO memory_policy(owner_id,scope,enabled) VALUES(?,?,1)",
  ).run(owner, "conversation:" + conversation);
  expect(await (await get(owner)).json()).toEqual({ memoryIncluded: true });
});
