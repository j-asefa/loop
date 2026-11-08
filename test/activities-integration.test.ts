import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityRecords } from "../src/client/ActivityRecords";
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020.js";
import { codexActivities } from "../src/adapters/direct-activities";
import { directActivityUpdate } from "../src/activity-bridge";
import {
  parseActivityUpdate,
  reduceActivities,
  type ActivityUpdate,
} from "../src/agent-activities";
import {
  visibleActivities,
  mergeActivities,
  type ActivityItem,
} from "../src/client/activityView";
const dir = mkdtempSync(join(tmpdir(), "loop-activity-integration-"));
process.env.LOOP_DATA_DIR = dir;
const { db } = await import("../src/server/db");
const { enqueue, claim } = await import("../src/server/queue");
const { applyActivity, listActivities, ingestNativeActivity } =
  await import("../src/server/activities");
const { nativeBindings } = await import("../src/server/native-tools");
const { historyActivities, historyProjection } =
  await import("../src/server/native-history");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const source = {
  transport: "native" as const,
  harness: "codex",
  origin: "direct",
};
function conversation(id: string, owner = "owner") {
  db.prepare(
    "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'t',0)",
  ).run(id, owner);
}

// Codex App Server item shapes (fields per the App Server documentation).
const codexThread = {
  turns: [
    {
      items: [
        {
          id: "u1",
          type: "userMessage",
          content: [{ type: "text", text: "go" }],
        },
        {
          id: "cmd-1",
          type: "commandExecution",
          status: "completed",
          command: "npm test",
          cwd: "/w",
          aggregatedOutput: "ok\n",
          exitCode: 0,
        },
        {
          id: "fc-1",
          type: "fileChange",
          status: "completed",
          changes: [
            { path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" },
            { path: "old.ts", kind: { move_path: "new.ts" }, diff: "" },
          ],
        },
        {
          id: "fc-2",
          type: "fileChange",
          status: "declined",
          changes: [{ path: "x.ts", diff: "+x" }],
        },
      ],
    },
  ],
};

it("maps direct extractions to valid shared updates without inferring content", () => {
  const updates = codexThread.turns[0].items.flatMap((item) =>
    codexActivities("item/completed", { item }).map((a) =>
      directActivityUpdate(a, { harness: "codex", generation: "g1" }),
    ),
  );
  for (const u of updates) expect(() => parseActivityUpdate(u)).not.toThrow();
  const [output, modify, rename, declined] = updates as any[];
  expect(output).toMatchObject({
    kind: "output",
    id: "cmd-1",
    generation: "g1",
    patch: { command: "npm test", cwd: "/w", status: "exited", exitCode: 0 },
  });
  expect(modify.patch).toMatchObject({ tool: "fc-1", state: "applied" });
  expect(modify.patch.files[0]).toMatchObject({
    path: "a.ts",
    operation: "modify",
  });
  expect(rename.patch.files[0]).toMatchObject({
    path: "new.ts",
    oldPath: "old.ts",
    operation: "rename",
  });
  // Declined is never shown as applied.
  expect(declined.patch.state).toBe("failed");
  expect(declined.patch.files[0].reason).toMatch(/declined/);
  // Plans map ids and flag positional fallbacks; statuses are validated.
  const [plan] = codexActivities("turn/plan/updated", {
    turnId: "t1",
    plan: [
      { step: "Read", status: "completed" },
      { step: "Write", status: "inProgress" },
    ],
  });
  expect(directActivityUpdate(plan, { harness: "codex" }).patch).toMatchObject({
    steps: [
      { id: "0", positional: true, title: "Read", status: "completed" },
      { id: "1", positional: true, title: "Write", status: "in_progress" },
    ],
  });
});

it("bounds large direct output into valid chunks and records upstream truncation", () => {
  const update = directActivityUpdate(
    {
      kind: "output",
      id: "o",
      text: "é".repeat(47_000),
      stream: "combined",
      state: "completed",
      truncated: true,
    },
    { harness: "pi" },
  );
  expect(() => parseActivityUpdate(update)).not.toThrow();
  const record = reduceActivities([{ update, turn: "t" }])
    .values()
    .next().value as any;
  expect(record.data.truncated.upstream).toBe(true);
  expect(
    Buffer.byteLength(record.data.chunks.map((c: any) => c.text).join("")),
  ).toBeLessThanOrEqual(64 * 1024);
  expect(record.data.truncated.droppedBytes).toBeGreaterThan(0);
});

it("projects native history as replay-only records and persists forks idempotently", () => {
  const projected = historyProjection(codexThread);
  expect(projected.map((p) => p.kind).sort()).toEqual([
    "file_change",
    "file_change",
    "file_change",
    "output",
  ]);
  for (const p of projected) expect(p.record.replayed).toBe(true);
  conversation("fork");
  for (let i = 0; i < 2; i++)
    for (const update of historyActivities(codexThread))
      applyActivity({ owner: "owner", conversation: "fork" }, update);
  const items = listActivities("owner", "fork").items;
  expect(items).toHaveLength(4);
  expect(
    items.every((i: any) => i.run === null && i.key.includes(":history:")),
  ).toBe(true);
  // A later live update for the same native id in a turn is a separate turn record.
  enqueue("owner", "t", "k-fork", { conversation: "fork" });
  const run = claim("w")!;
  const live = { run, generation: "g2", binding: { conversation_id: "fork" } };
  expect(
    ingestNativeActivity(
      live,
      directActivityUpdate(
        codexActivities("item/completed", {
          item: codexThread.turns[0].items[1],
        })[0],
        {
          harness: "codex",
          generation: "g2",
        },
      ),
    ),
  ).toMatchObject({ applied: true });
  expect(listActivities("owner", "fork").items).toHaveLength(5);
});

it("persisted records equal the pure fold for duplicated, out-of-order delivery", () => {
  conversation("persist");
  enqueue("owner", "t", "k-persist", { conversation: "persist" });
  const run = claim("w")!;
  const out = (seq: number, patch: object): ActivityUpdate => ({
    v: 1,
    kind: "output",
    id: "o1",
    source,
    generation: "g",
    seq,
    patch: patch as any,
  });
  const updates: ActivityUpdate[] = [
    out(0, {
      command: "make",
      append: [{ stream: "stdout", text: "a", index: 0 }],
    }),
    out(2, { append: [{ stream: "stderr", text: "c", index: 2 }] }),
    out(1, { append: [{ stream: "stdout", text: "b", index: 1 }] }),
    out(2, { append: [{ stream: "stderr", text: "c", index: 2 }] }),
    out(3, { status: "exited", exitCode: 2, cwd: null, command: "make -j" }),
    // Older than the seq that last wrote `command`: ignored.
    out(1, { command: "stale" }),
  ];
  const scope = {
    owner: "owner",
    conversation: "persist",
    run: run.id,
    generation: "g",
  };
  for (const u of updates) applyActivity(scope, u);
  const [stored] = listActivities("owner", "persist").items as any[];
  const pure = reduceActivities(
    updates.map((update) => ({ update, turn: run.id })),
  );
  expect(stored.record).toEqual(pure.get(stored.key));
  expect(stored.record.data).toMatchObject({
    command: "make -j",
    status: "exited",
    exitCode: 2,
  });
  expect(stored.record.data.chunks.map((c: any) => c.text).join("")).toBe(
    "abc",
  );
  // Other generations are quarantined; the owning generation still applies.
  expect(
    applyActivity(scope, { ...out(9, { command: "x" }), generation: "old" }),
  ).toMatchObject({
    applied: false,
    reason: "stale generation",
  });
  // Change notifications carry only identity, never content.
  const events = db
    .prepare(
      "SELECT payload FROM events WHERE run_id=? AND type='activity.updated'",
    )
    .all(run.id) as { payload: string }[];
  expect(events.length).toBeGreaterThan(0);
  for (const e of events)
    expect(Object.keys(JSON.parse(e.payload)).sort()).toEqual([
      "key",
      "kind",
      "sequence",
    ]);
});

it("client merge keeps the newest record per key and renders the production activity components", () => {
  const item = (key: string, sequence: number, record: any): ActivityItem => ({
    key,
    kind: record.kind,
    run: "r",
    sequence,
    record,
  });
  const file = (state: string) => ({
    v: 1,
    kind: "file_change",
    id: "f",
    source: { transport: "native", harness: "codex" },
    data: {
      state,
      files: [
        {
          path: "<img src=x>.ts",
          operation: "create",
          before: null,
          after: "x",
          content: "available",
        },
        { path: "gone.bin", operation: "delete", content: "binary" },
      ],
    },
  });
  let items = mergeActivities([], { items: [item("f", 5, file("applied"))] });
  // An overlapping older page after reconnect does not regress the view.
  items = mergeActivities(items, { items: [item("f", 3, file("proposed"))] });
  const render = () =>
    renderToStaticMarkup(
      createElement(ActivityRecords, {
        records: visibleActivities(items).map((item) => item.record),
      }),
    );
  const html = render();
  expect(html).toContain("&lt;img src=x&gt;.ts");
  expect(html).not.toContain("<img");
  expect(html).toContain("applied · create");
  expect(html).toContain("applied · delete");
  expect(html).not.toContain("proposed");
  expect(html).toContain("new file");
  expect(html).toContain("binary");
  expect(html).not.toContain("Diff content was not supplied");
  // New records replace the same activity key; unknown versions are skipped.
  items = mergeActivities(
    [
      item("t", 0, {
        v: 1,
        kind: "tool",
        source: { transport: "native", harness: "codex" },
        data: { title: "x", status: "unknown", content: [] },
      }),
    ],
    {
      items: [
        item("t", 0, {
          v: 1,
          kind: "tool",
          source: { transport: "native", harness: "codex" },
          data: { title: "y", status: "completed", content: [] },
        }),
        item("z", 9, { v: 2, kind: "plan" }),
      ],
    },
  );
  expect(
    visibleActivities(items).map((item) =>
      item.record.kind === "tool" ? item.record.data.title : undefined,
    ),
  ).toEqual(["y"]);
  expect(render()).toContain("y · completed");
});

it("offers loop_plan with a provider-compatible, validated schema and agent-facing description", () => {
  conversation("schema");
  enqueue("owner", "t", "k-schema", { conversation: "schema" });
  const run = claim("w")!;
  const plan = nativeBindings(run, { plans: true }).find(
    (b) => b.tool === "loop_plan",
  )!;
  expect(nativeBindings(run).some((b) => b.tool === "loop_plan")).toBe(false);
  const schema = plan.inputSchema as any;
  // OpenAI (strict: false) and Anthropic both require a top-level object without refs.
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["steps"]);
  expect(JSON.stringify(schema)).not.toContain("$ref");
  const validate = new Ajv2020({ strict: false }).compile(schema);
  expect(
    validate({ steps: [{ id: "a", title: "Do", status: "in_progress" }] }),
  ).toBe(true);
  expect(validate({ steps: [{ title: "Do", status: "started" }] })).toBe(false);
  expect(validate({ steps: [] })).toBe(false);
  expect(
    validate({ steps: [{ id: "has space", title: "Do", status: "pending" }] }),
  ).toBe(false);
  expect(plan.description).toMatch(/never infers a plan/);
});

it("migration 030 is additive and preserves conversations and native bindings", () => {
  const old = new Database(":memory:");
  try {
    const files = readdirSync("migrations")
      .filter((f) => /^\d+.*\.sql$/.test(f))
      .sort();
    for (const file of files.filter((f) => f < "030"))
      old.exec(readFileSync("migrations/" + file, "utf8"));
    old
      .prepare(
        "INSERT INTO conversations(id,owner_id,title,created_at) VALUES('c','o','t',0)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,generation,updated_at) VALUES('c','codex','thread-1','/p','g',0)",
      )
      .run();
    const before = old.prepare("SELECT * FROM companion_sessions").all();
    for (const file of files.filter((f) => f.startsWith("030-")))
      old.exec(readFileSync("migrations/" + file, "utf8"));
    expect(old.prepare("SELECT * FROM companion_sessions").all()).toMatchObject(
      before,
    );
    expect(
      old.prepare("SELECT count(*) n FROM agent_activities").get(),
    ).toEqual({ n: 0 });
  } finally {
    old.close();
  }
});

it("live adapters and native history share one direct mapping", async () => {
  const { directUpdates } = await import("../src/adapters/direct-activities");
  const item = {
    id: "fc",
    type: "fileChange",
    status: "completed",
    changes: [
      { path: "added.ts", kind: { type: "add" }, diff: "+x\n" },
      { path: "gone.ts", kind: { type: "delete" }, diff: "-x\n" },
      {
        path: "old.ts",
        kind: { type: "update", move_path: "new.ts" },
        diff: "",
      },
    ],
  };
  const values = codexActivities("item/completed", { item });
  const live = directUpdates("codex", values);
  const history = values.map((v) =>
    directActivityUpdate(v, { harness: "codex", replay: true }),
  );
  // Only provenance and the replay flag differ.
  expect(live.map((u) => u.patch)).toEqual(history.map((u) => u.patch));
  expect(
    live.map((u: any) => [u.patch.files[0].operation, u.patch.files[0].path]),
  ).toEqual([
    ["create", "added.ts"],
    ["delete", "gone.ts"],
    ["rename", "new.ts"],
  ]);
});
