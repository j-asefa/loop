import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ArtifactMetadata,
  ConnectionMetadata,
  ConnectionModels,
  MessageMetadata,
  RunPayload,
  SealedEnvelope,
} from "../src/server/row-schemas.js";
const dir = mkdtempSync(join(tmpdir(), "loop-typed-rows-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db, id, now } = await import("../src/server/db.js");
const { seal } = await import("../src/server/secrets.js");
const { createAgent, ownedRun, ownedConnection, ownedMessage, ownedArtifact } =
  await import("../src/server/domain.js");
const { submit } = await import("../src/server/agent-runtime.js");
const { tick, execute } = await import("../src/server/worker.js");
const { withTestAdapter } = await import("../src/server/providers.js");
const { saveArtifact } = await import("../src/server/artifacts.js");
let effects = 0;
const restore = withTestAdapter("openai", {
  async models() {
    return [{ id: "fixture", name: "Fixture", capabilities: "Fixture only" }];
  },
  async *stream() {
    effects++;
    yield { text: "Typed fixture answer." };
  },
});
afterAll(() => {
  restore();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const owner = id(),
    connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,'{}',?)",
  ).run(
    connection,
    owner,
    seal("fixture-key", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  const agent = createAgent(owner, {
    name: "typed-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const run = submit(owner, {
    agentId: agent.id,
    input: "Typed row fixture",
    idempotencyKey: id(),
  });
  return { owner, connection, agent, run };
}

it("decodes production rows once, defaults only an absent model label, and preserves owner isolation", async () => {
  const { owner, connection, run } = fixture();
  expect(ownedConnection(connection, owner).models).toEqual([
    { id: "fixture", name: "fixture" },
  ]);
  expect(ownedConnection(connection, owner).metadata).toEqual({});
  expect(ownedRun(run.id, owner).payload).toEqual(run.payload);
  expect(() => ownedRun(run.id, "other-owner")).toThrow("Item not found");
  expect(await tick(execute)).toBe(true);
  expect(ownedRun(run.id, owner).state).toBe("completed");
  const message = db
    .prepare(
      "SELECT id,metadata FROM messages WHERE run_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1",
    )
    .get(run.id) as { id: string; metadata: string };
  const artifact = db
    .prepare(
      "SELECT id,metadata FROM artifacts WHERE run_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(run.id) as { id: string; metadata: string };
  expect(ownedMessage(message.id, owner).metadata).toEqual(
    JSON.parse(message.metadata),
  );
  expect(ownedArtifact(artifact.id, owner).metadata).toEqual(
    JSON.parse(artifact.metadata),
  );
  expect(
    SealedEnvelope.safeParse(ownedConnection(connection, owner).secret).success,
  ).toBe(true);
});

it.each([
  ["reviewId", false],
  ["reviewId", null],
  ["reviewId", ""],
  ["teamId", []],
  ["teamId", null],
  ["connectionId", 123],
  ["agentId", {}],
  ["permissionMode", "allow-everything"],
  ["permissionMode", null],
  ["maxSeconds", 0],
  ["model", ""],
  ["maxTokens", 1.5],
])(
  "records invalid present %s on a queued row without dispatching it",
  async (field, value) => {
    const { owner, run } = fixture(),
      before = effects;
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(
      JSON.stringify({ ...run.payload, [field]: value }),
      run.id,
    );
    expect(() => ownedRun(run.id, owner)).toThrow(run.id);
    await tick(execute);
    expect(effects).toBe(before);
    expect(
      db
        .prepare("SELECT state,error,worker_id FROM runs WHERE id=?")
        .get(run.id),
    ).toEqual({
      state: "failed",
      error: expect.stringContaining(run.id),
      worker_id: null,
    });
    expect(
      db.prepare("SELECT 1 FROM native_dispatch WHERE run_id=?").get(run.id),
    ).toBeUndefined();
  },
);

it.each([
  ["loopHarness", false],
  ["loopHarness", null],
  ["loopHarness", "unknown"],
  ["permissionMode", "allow-everything"],
  ["runtimeKind", "other-host"],
])(
  "fails closed for malformed connection %s and records its identity",
  async (field, value) => {
    const { connection, owner, run } = fixture(),
      before = effects;
    db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
      JSON.stringify({ [field]: value }),
      connection,
    );
    expect(() => ownedConnection(connection, owner)).toThrow(connection);
    await tick(execute);
    expect(effects).toBe(before);
    expect(
      db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
    ).toEqual({ state: "failed", error: expect.stringContaining(connection) });
  },
);

it.each(["", "not-a-sealed-envelope", "YQ==.Yg==.Yw=="])(
  "never executes a provider key connection with invalid credentials (%s)",
  async (secret) => {
    const { connection, run } = fixture(),
      before = effects;
    db.prepare("UPDATE connections SET secret=? WHERE id=?").run(
      secret,
      connection,
    );
    await tick(execute);
    expect(effects).toBe(before);
    expect(
      db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
    ).toEqual({ state: "failed", error: expect.stringContaining(connection) });
  },
);

it("rejects invalid present display fields and unknown new writes without repairing the stored row", () => {
  const { connection, owner, run } = fixture();
  db.prepare("UPDATE runs SET state='cancelled' WHERE id=?").run(run.id);
  db.prepare("UPDATE connections SET models=? WHERE id=?").run(
    '[{"id":"fixture","name":42}]',
    connection,
  );
  expect(() => ownedConnection(connection, owner)).toThrow("models");
  for (const schema of [
    RunPayload,
    MessageMetadata,
    ArtifactMetadata,
    ConnectionMetadata,
  ])
    expect(schema.safeParse({ accidentalField: true }).success).toBe(false);
  expect(ConnectionModels.safeParse([{ id: "fixture" }]).success).toBe(false);
  expect(() =>
    saveArtifact(owner, {
      title: "Invalid",
      content: "Never stored",
      metadata: { reviewId: false },
    }),
  ).toThrow();
  expect(
    db
      .prepare("SELECT 1 FROM artifacts WHERE owner_id=? AND title='Invalid'")
      .get(owner),
  ).toBeUndefined();
});

it("rejects a non-object JSON payload before queue routing and still executes an unrelated row", async () => {
  const bad = fixture(),
    good = fixture(),
    before = effects;
  db.prepare("UPDATE runs SET payload='null' WHERE id=?").run(bad.run.id);
  await tick(execute);
  expect(
    db.prepare("SELECT state,error FROM runs WHERE id=?").get(bad.run.id),
  ).toEqual({ state: "failed", error: expect.stringContaining(bad.run.id) });
  expect(ownedRun(good.run.id, good.owner).state).toBe("completed");
  expect(effects).toBe(before + 1);
});

it("can interrupt a native run with malformed saved identity without replaying or blocking recovery", async () => {
  const { owner, connection, run } = fixture(),
    before = effects;
  db.prepare("UPDATE connections SET metadata=? WHERE id=?").run(
    JSON.stringify({ loopHarness: "codex" }),
    connection,
  );
  db.prepare("UPDATE runs SET state='running',payload=? WHERE id=?").run(
    JSON.stringify({ ...run.payload, reviewId: null }),
    run.id,
  );
  const { nativeSessions } = await import("../src/server/native-sessions.js");
  nativeSessions.recover();
  expect(
    db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
  ).toEqual({ state: "interrupted", error: expect.stringContaining(run.id) });
  expect(effects).toBe(before);
  expect(() => ownedRun(run.id, owner)).toThrow(run.id);
});

it("refuses unknown saved execution fields without an external effect", async () => {
  const { owner, run } = fixture(),
    before = effects;
  const payload = JSON.stringify({
    ...run.payload,
    unknownExecutionField: "unsupported",
  });
  db.prepare("UPDATE runs SET payload=? WHERE id=?").run(payload, run.id);
  await tick(execute);
  expect(effects).toBe(before);
  expect(() => ownedRun(run.id, owner)).toThrow(run.id);
  expect(
    db.prepare("SELECT state,payload FROM runs WHERE id=?").get(run.id),
  ).toEqual({ state: "failed", payload });
});

it("records an invalid saved scalar with its connection identity before execution", async () => {
  const { connection, owner, run } = fixture(),
    before = effects;
  db.prepare("UPDATE connections SET created_at='invalid-time' WHERE id=?").run(
    connection,
  );
  expect(() => ownedConnection(connection, owner)).toThrow(connection);
  await tick(execute);
  expect(effects).toBe(before);
  expect(
    db.prepare("SELECT state,error FROM runs WHERE id=?").get(run.id),
  ).toEqual({ state: "failed", error: expect.stringContaining(connection) });
});
