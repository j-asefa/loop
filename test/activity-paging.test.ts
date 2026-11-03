import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
  recordedSessionControls,
  visibleActivities,
} from "../src/client/activityView";

const dir = mkdtempSync(join(tmpdir(), "loop-activity-paging-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { activityRoutes, applyActivity, setActivityCapabilities } =
  await import("../src/server/activities");
db.exec(`INSERT INTO conversations(id,owner_id,title,created_at) VALUES('c','alice','Long',1),('other','alice','Other',1);
  INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,created_at,updated_at)
  VALUES('r','alice','c','agent','prompt','completed','r',1,1),('other','alice','other','agent','prompt','completed','other',1,1);`);
const app = express();
app.use((req, res, next) => {
  res.locals.owner = req.get("x-owner") || "alice";
  next();
});
app.use(activityRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const get = async (query: string, owner = "alice", conversation = "c") => {
  const res = await fetch(
    `${base}/conversations/${conversation}/activities${query}`,
    { headers: { "x-owner": owner } },
  );
  return { status: res.status, body: await res.json() };
};
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function add(
  sequence: number,
  kind = "tool",
  run: string | null = "r",
  scope = "c",
  data?: any,
) {
  const source = {
    transport: "native",
    harness: "codex",
    origin: "paging-fixture",
  };
  const context = {
    owner: "alice",
    conversation: scope,
    run,
    generation: "g1",
  };
  const patch =
    data ??
    (kind === "file_change" ? { files: [] } : { title: `tool ${sequence}` });
  if (kind === "file_change" && patch.files)
    patch.files = patch.files.map((file: object) => ({
      operation: "modify",
      ...file,
    }));
  const result =
    kind === "capabilities"
      ? setActivityCapabilities(context, source, {})
      : applyActivity(context, {
          v: 1,
          kind,
          id: `${scope}:${kind}:${sequence}`,
          source,
          generation: "g1",
          patch,
        });
  expect(result.applied).toBe(true);
  if (!result.applied) throw new Error("Fixture activity was rejected");
  // Exercise gaps and page boundaries without bypassing the production record writer.
  db.prepare(
    "UPDATE agent_activities SET sequence=? WHERE owner_id='alice' AND scope=? AND activity_key=?",
  ).run(sequence, scope, result.key);
  return result.key;
}

it("opens with only recent activity and confirmed controls, then pages older records without gaps", async () => {
  add(1, "settings", null, "c", {
    options: [{ id: "model", confirmed: "fixture" }],
  });
  add(2, "capabilities", null);
  add(3, "file_change", "r", "c", { files: [{ path: "old.ts" }] });
  db.transaction(() => {
    for (let i = 4; i <= 1205; i++) add(i);
  })();
  add(1206, "tool", "other", "other");
  const initial = await get("?view=recent");
  expect(initial.status).toBe(200);
  expect(initial.body.items).toHaveLength(102);
  expect(initial.body.cursor).toBe(1205);
  expect(initial.body.more).toBe(false);
  expect(recordedSessionControls(initial.body.items).settings).toMatchObject({
    generation: "g1",
    data: { options: [{ id: "model", confirmed: "fixture" }] },
  });
  expect(initial.body.items.some((i: any) => i.sequence === 1206)).toBe(false);
  const seen = new Set(initial.body.items.map((i: any) => i.sequence));
  let before = initial.body.earlier;
  while (before !== null) {
    const page = await get(`?view=recent&before=${before}`);
    expect(page.body.items.length).toBeLessThanOrEqual(100);
    for (const item of page.body.items) seen.add(item.sequence);
    before = page.body.earlier;
  }
  expect(seen.size).toBe(1205);
  const files = await get("?view=files&runs=r,other&after=0");
  expect(files.body.items.map((i: any) => [i.kind, i.sequence])).toEqual([
    ["file_change", 3],
  ]);
  add(1300);
  const delta = await get("?view=updates&after=1205");
  expect(delta.body.items.map((i: any) => i.sequence)).toEqual([1300]);
  expect((await get("?view=recent", "bob")).status).toBe(404);
  expect((await get("?view=files&runs=r", "bob")).status).toBe(404);
  expect((await get("?view=files")).status).toBe(400);
  expect((await get("?view=recent&before=bad")).status).toBe(400);
});

it("loads legacy traces only on demand, pages past 2000 and hides internal envelopes", async () => {
  const insertTrace = db.prepare(
    "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES('alice','r',?,'tool',?,'old output',?,1)",
  );
  db.transaction(() => {
    for (let i = 0; i < 2010; i++)
      insertTrace.run(`legacy:${i}`, `Legacy ${i}`, "{}");
    insertTrace.run("native:envelope", "StructuredOutput", '{"native":true}');
    insertTrace.run("native:envelope:result", "Tool result", '{"native":true}');
  })();
  const initial = await get("?view=recent");
  expect(initial.body.legacyAvailable).toBe(true);
  expect(initial.body.items.every((i: any) => !i.legacy)).toBe(true);
  expect(
    (await get("?view=updates&after=0")).body.items.every(
      (i: any) => !i.legacy,
    ),
  ).toBe(true);
  let before: number | null = Number.MAX_SAFE_INTEGER;
  const traces = new Set<string>();
  while (before !== null) {
    const page = await get(`?view=legacy&before=${before}`);
    expect(page.body.items.length).toBeLessThanOrEqual(100);
    expect(page.body.items.every((i: any) => i.legacy)).toBe(true);
    for (const item of page.body.items) traces.add(item.key);
    before = page.body.earlier;
  }
  expect(traces.size).toBe(2010);
  expect([...traces].join("\n")).not.toContain("envelope");
  expect((await get("?view=legacy", "bob")).status).toBe(404);
  // A later durable record still suppresses its already-loaded legacy twin.
  const legacy = (await get(`?view=legacy&before=${Number.MAX_SAFE_INTEGER}`))
    .body.items[0];
  const durable = {
    ...legacy,
    key: "durable",
    sequence: 1301,
    legacy: false,
    record: {
      ...legacy.record,
      data: { ...legacy.record.data, links: { trace: legacy.record.id } },
    },
  };
  expect(visibleActivities([legacy, durable])).toEqual([durable]);
});

it("offers older activity and legacy traces only when the reader would see them", async () => {
  db.exec(`INSERT INTO conversations(id,owner_id,title,created_at) VALUES('quiet','alice','Quiet',1);
    INSERT INTO runs(id,owner_id,conversation_id,kind,input,state,idempotency_key,created_at,updated_at)
    VALUES('quiet','alice','quiet','agent','prompt','completed','quiet',1,1);`);
  db.transaction(() => {
    for (let i = 1; i <= 149; i++)
      add(i, "file_change", "quiet", "quiet", {
        files: [{ path: `f${i}.ts` }],
      });
    add(150, "tool", "quiet", "quiet");
  })();
  const recent = await get("?view=recent", "alice", "quiet");
  expect(recent.body.items.some((i: any) => i.sequence === 150)).toBe(true);
  // The older records are all file changes, which load with their own run.
  expect(recent.body.earlier).toBeNull();
  expect(recent.body.legacyAvailable).toBe(false);
  const trace = db.prepare(
    "INSERT INTO run_traces(owner_id,run_id,trace_key,kind,title,content,metadata,created_at) VALUES('alice','quiet',?,'tool',?,'old output',?,1)",
  );
  db.transaction(() => {
    trace.run("native:envelope", "StructuredOutput", '{"native":true}');
    trace.run("native:envelope:result", "Tool result", '{"native":true}');
    trace.run("plan:1", "loop_plan", "{}");
    trace.run("plan:old", "loop_plan", "{}");
  })();
  // Internal envelopes and plan calls are not history anyone can load.
  expect(
    (await get("?view=recent", "alice", "quiet")).body.legacyAvailable,
  ).toBe(false);
  expect(
    (
      await get(
        `?view=legacy&before=${Number.MAX_SAFE_INTEGER}`,
        "alice",
        "quiet",
      )
    ).body.items,
  ).toEqual([]);
  trace.run("tool:web", "web_fetch", "{}");
  const available = await get("?view=recent", "alice", "quiet");
  expect(available.body.legacyAvailable).toBe(true);
  expect(
    (
      await get(
        `?view=legacy&before=${Number.MAX_SAFE_INTEGER}`,
        "alice",
        "quiet",
      )
    ).body.items.map((item: any) => item.record.data.title),
  ).toEqual(["web_fetch"]);
  // A durable record for another run cannot hide this run's trace.
  add(151, "tool", "other", "quiet", {
    title: "Other run",
    links: { trace: "tool:web" },
  });
  expect(
    (await get("?view=recent", "alice", "quiet")).body.legacyAvailable,
  ).toBe(true);
  add(152, "tool", "quiet", "quiet", {
    title: "Durable web fetch",
    links: { trace: "tool:web" },
  });
  expect(
    (await get("?view=recent", "alice", "quiet")).body.legacyAvailable,
  ).toBe(false);
  expect(
    (
      await get(
        `?view=legacy&before=${Number.MAX_SAFE_INTEGER}`,
        "alice",
        "quiet",
      )
    ).body.items,
  ).toEqual([]);
});

it("serves conversation controls without reading traces or returning tool history", async () => {
  // If the conversation request touches legacy storage, fail at the database
  // boundary. Restore it before subsequent fixture teardown.
  db.exec("ALTER TABLE run_traces RENAME TO unavailable_traces");
  try {
    const initial = await get("?view=recent&tools=0");
    expect(initial.status).toBe(200);
    expect(initial.body.items.length).toBeGreaterThan(0);
    expect(
      initial.body.items.every((i: any) =>
        ["settings", "commands", "capabilities"].includes(i.kind),
      ),
    ).toBe(true);
    expect(initial.body.legacyAvailable).toBeUndefined();
    const updates = await get("?view=updates&tools=0&after=0");
    expect(updates.status).toBe(200);
    expect(
      updates.body.items.every((i: any) =>
        ["settings", "commands", "capabilities", "file_change"].includes(
          i.kind,
        ),
      ),
    ).toBe(true);
    expect((await get("?view=recent&tools=0", "bob")).status).toBe(404);
  } finally {
    db.exec("ALTER TABLE unavailable_traces RENAME TO run_traces");
  }
});
