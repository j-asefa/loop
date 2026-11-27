import { randomBytes } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { productionApp } from "./helpers/app.js";
import { seedConnection, seedConversation } from "./helpers/seed.js";
import { testDirectory } from "./helpers/test-workspace.js";
import {
  createEmptySnippetUsageMap,
  sortSnippetsByUsage,
} from "../apps/mobile/src/snippet-usage-codec.js";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { createAgent } = await import("../src/server/domain");
const { mobile } = await import("../src/server/mobile-routes");
const { core } = await import("../src/server/core-routes");
const { workspace } = await import("../src/server/workspace-routes");

const app = await productionApp(undefined, [mobile, core, workspace], {
  ownerHeader: "x-owner",
});

async function api(
  owner: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`${app.url}/api${path}`, {
    method,
    headers: { "x-owner": owner, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}

afterAll(async () => {
  await app.close();
  db.close();
});

it("keeps personal snippet usage accurate past 2,000 excluded messages and retains new snippets past 100 used ones", async () => {
  const owner = id();
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
  const cid = id();
  seedConversation(db, {
    id: cid,
    owner_id: owner,
    agent_id: agent.id,
    title: "Bulk snippet history",
    created_at: now(),
  });

  await api(owner, "/artifacts", "POST", {
    title: "Snippet: Older real",
    content: "Older real snippet",
    metadata: { snippet: true },
  });
  await api(owner, "/runs", "POST", {
    agentId: agent.id,
    conversationId: cid,
    input: "Older real snippet",
    idempotencyKey: "old-real-" + randomBytes(6).toString("hex"),
    queue: true,
  });

  // Seed >2,000 excluded messages (imported without run_id + automation mail) newer than the real send.
  const insertRun = db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,idempotency_key,state,payload,created_at,updated_at) VALUES(?,?,?,?,'hi',?,'completed','{}',?,?)",
  );
  const insertMsg = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'user',?,?,?)",
  );
  const insertSnippet = db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,role,content,metadata,created_at,updated_at) VALUES(?,?,?,'markdown','snippet',?,'{\"snippet\":true}',?,?)",
  );
  const floodTs = now() + 1000;
  db.transaction(() => {
    for (let i = 0; i < 1050; i++) {
      insertMsg.run(
        id(),
        owner,
        cid,
        null,
        "Older real snippet",
        JSON.stringify({ personal: true }),
        floodTs + i,
      );
    }
    for (let i = 0; i < 1050; i++) {
      const rid = id();
      insertRun.run(
        rid,
        owner,
        agent.id,
        cid,
        "excl-" + i + "-" + rid,
        floodTs + 2000 + i,
        floodTs + 2000 + i,
      );
      insertMsg.run(
        id(),
        owner,
        cid,
        rid,
        "Older real snippet",
        JSON.stringify({ personal: true, automation: { mailId: `m-${i}` } }),
        floodTs + 2000 + i,
      );
    }
  })();

  const beforeBulk = (await api(owner, "/snippets")).data.items;
  expect(beforeBulk[0]).toMatchObject({
    content: "Older real snippet",
    use_count: 1,
  });

  // Seed 105 older snippets (with oldest i=0..4 heavily used and newer i=7..104 unused),
  // plus one brand-new unused snippet: the server must keep the exact newest 100 snippets so an
  // older >100th snippet never pushes an unarchived recent snippet out of web's '/' picker.
  const baseTs = now() - 200_000;
  db.transaction(() => {
    for (let i = 0; i < 105; i++) {
      const text = `Bulk snippet ${i}`;
      insertSnippet.run(
        id(),
        owner,
        `Snippet: ${i}`,
        text,
        baseTs + i,
        baseTs + i,
      );
      if (i < 5) {
        for (let k = 0; k < 3; k++) {
          const rid = id();
          insertRun.run(
            rid,
            owner,
            agent.id,
            cid,
            "bulk-" + i + "-" + k + "-" + rid,
            baseTs + i + k,
            baseTs + i + k,
          );
          insertMsg.run(
            id(),
            owner,
            cid,
            rid,
            text,
            JSON.stringify({ personal: true }),
            baseTs + i + k,
          );
        }
      }
    }
  })();

  const brandNew = await api(owner, "/artifacts", "POST", {
    title: "Snippet: Brand new",
    content: "Brand new unused snippet",
    metadata: { snippet: true },
  });
  expect(brandNew.status).toBe(201);

  const items = (await api(owner, "/snippets")).data.items;
  expect(items).toHaveLength(100);
  // Server keeps the exact newest 100 snippets (Bulk snippet 0..6 excluded, Bulk snippet 7..104 + Older real + Brand new).
  expect(items[0].content).toBe("Brand new unused snippet");
  expect(items.some((s: any) => s.content === "Bulk snippet 7")).toBe(true);
  expect(items.some((s: any) => s.content === "Bulk snippet 0")).toBe(false);
  expect(items.some((s: any) => s.content === "Older real snippet")).toBe(true);
  const mobileSorted = sortSnippetsByUsage(items, createEmptySnippetUsageMap());
  expect(mobileSorted[0].content).toBe("Older real snippet");
});
