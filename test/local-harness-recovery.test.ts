import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "loop55-native-recovery-"));
process.env.LOOP55_DATA_DIR = root;
process.env.LOOP55_PROFILE = "companion";
const probe = vi.hoisted(() => vi.fn());
vi.mock("../src/host-control.js", () => ({ discover: probe }));
const { db, id, now } = await import("../src/server/db");
const { OWNER, nativeSessions } = await import("../src/server/native-sessions");
const { prepareLocalHarnesses } = await import("../src/server/local-harnesses");
const { Codex } = await import("../src/adapters/codex");
const { Claude } = await import("../src/adapters/claude");
const { Pi } = await import("../src/adapters/pi");
const { createTeam } = await import("../src/server/teams");
const { createAgent } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
afterEach(() => {
  vi.restoreAllMocks();
  probe.mockReset();
});
afterAll(async () => {
  await nativeSessions.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function connection(name: string, status: string, retired = false) {
  db.prepare(
    "INSERT OR REPLACE INTO connections(id,owner_id,provider,label,secret,status,metadata,models,created_at) VALUES(?,?,?,'Native','',?,?,?,?)",
  ).run(
    "native-" + name,
    OWNER,
    name === "claude" ? "anthropic" : name,
    status,
    JSON.stringify({
      loop55Harness: name,
      authMode: "subscription",
      ...(retired ? { retiredDirectRuntime: true } : {}),
    }),
    JSON.stringify([{ id: "native-default" }]),
    now(),
  );
}
function mocks() {
  probe.mockImplementation(async (name: string) => ({
    installed: true,
    supported: true,
    version: "fixture",
    executable: "/fixture/" + name,
  }));
  vi.spyOn(Codex.prototype, "start").mockResolvedValue({
    mode: "subscription",
    description: "fixture",
  });
  vi.spyOn(Codex.prototype, "dispose").mockResolvedValue();
  vi.spyOn(Pi.prototype, "start").mockResolvedValue({
    mode: "existing",
    description: "fixture",
  });
  vi.spyOn(Pi.prototype, "dispose").mockResolvedValue();
  vi.spyOn(Claude.prototype, "start").mockRejectedValue(
    new Error("private authentication detail"),
  );
  vi.spyOn(Claude.prototype, "dispose").mockResolvedValue();
}
it("recovers retired connections only after account verification, preserving team threads and native identities", async () => {
  connection("codex", "connected");
  connection("pi", "connected");
  connection("claude", "connected");
  const manager = createAgent(OWNER, {
    name: "manager",
    connectionId: "native-codex",
    model: "native-default",
  });
  const worker = createAgent(OWNER, {
    name: "worker",
    connectionId: "native-pi",
    model: "native-default",
  });
  const team = createTeam(OWNER, {
    name: "Recovery",
    managerId: manager.id,
    members: [worker.id],
  });
  const first = submit(OWNER, {
    agentId: manager.id,
    conversationId: team.conversation_id!,
    input: "Existing task",
    idempotencyKey: id(),
  });
  db.prepare(
    "UPDATE runs SET state='failed',error='requires HAPI' WHERE id=?",
  ).run(first.id);
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,state,updated_at) VALUES(?,'codex','original-native-thread',?,'disconnected',?)",
  ).run(team.conversation_id, root, now());
  db.exec(
    "UPDATE connections SET status='disconnected',metadata=json_set(metadata,'$.retiredDirectRuntime',json('true')); DELETE FROM schema_version WHERE version=71",
  );
  db.exec(
    readFileSync(
      new URL(
        "../migrations/071-restore-native-harnesses.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(
    db.prepare("SELECT status FROM connections WHERE id='native-codex'").get(),
  ).toEqual({ status: "needs_sign_in" });
  mocks();
  const result = await prepareLocalHarnesses(root, ["codex", "claude", "pi"]);
  expect(result.billing.description).toContain("2 native harnesses ready");
  expect(
    db.prepare("SELECT status FROM connections WHERE id='native-claude'").get(),
  ).toEqual({ status: "needs_sign_in" });
  expect(
    db.prepare("SELECT status FROM connections WHERE id='native-codex'").get(),
  ).toEqual({ status: "connected" });
  expect(
    db
      .prepare(
        "SELECT native_id FROM companion_sessions WHERE conversation_id=?",
      )
      .get(team.conversation_id),
  ).toEqual({ native_id: "original-native-thread" });
  expect(
    db.prepare("SELECT conversation_id FROM teams WHERE id=?").get(team.id),
  ).toEqual({ conversation_id: team.conversation_id });
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(first.id)).toEqual(
    { state: "failed" },
  );
  const next = submit(OWNER, {
    agentId: manager.id,
    conversationId: team.conversation_id!,
    input: "Continue",
    idempotencyKey: id(),
  });
  expect(next.conversation_id).toBe(team.conversation_id);
  expect(next.payload.execution).toBeUndefined();
});
it("leaves intentional disconnects disconnected and does not invoke their account probes", async () => {
  connection("codex", "disconnected");
  mocks();
  await prepareLocalHarnesses(root, ["codex"]);
  expect(probe).not.toHaveBeenCalled();
  expect(Codex.prototype.start).not.toHaveBeenCalled();
  expect(
    db.prepare("SELECT status FROM connections WHERE id='native-codex'").get(),
  ).toEqual({ status: "disconnected" });
});
it("keeps other harnesses usable when discovery fails and never substitutes a billing policy", async () => {
  connection("codex", "needs_sign_in", true);
  mocks();
  probe.mockImplementation(async (name: string) => {
    if (name === "claude") throw new Error("offline");
    return {
      installed: true,
      supported: true,
      version: "fixture",
      executable: "/fixture/" + name,
    };
  });
  await prepareLocalHarnesses(root, ["claude", "codex"]);
  expect(
    db.prepare("SELECT status FROM connections WHERE id='native-codex'").get(),
  ).toEqual({ status: "connected" });
  expect(nativeSessions.registration("codex").billing).toBe("subscription");
});

it("keeps an explicitly revoked damaged native connection disconnected on startup", async () => {
  connection("codex", "connected", true);
  db.prepare(
    "UPDATE connections SET metadata=json_set(metadata,'$.permissionMode','bogus','$.nativeRecoveryRequired',json('true')) WHERE id='native-codex'",
  ).run();
  const { default: express } = await import("express");
  const { core } = await import("../src/server/core-routes");
  const { errorHandler } = await import("../src/server/error-handler");
  const app = express();
  app.use((req, res, next) => {
    res.locals.owner = req.get("x-owner");
    next();
  });
  app.use(core, errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  try {
    const url = `http://127.0.0.1:${address.port}/connections/native-codex`;
    expect(
      (
        await fetch(url, {
          method: "DELETE",
          headers: { "x-owner": "foreign" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(url, { method: "DELETE", headers: { "x-owner": OWNER } }))
        .status,
    ).toBe(200);
    const saved = db
      .prepare("SELECT metadata FROM connections WHERE id='native-codex'")
      .get() as { metadata: string };
    mocks();
    await prepareLocalHarnesses(root, ["codex"]);
    expect(probe).not.toHaveBeenCalled();
    expect(Codex.prototype.start).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT status,secret FROM connections WHERE id='native-codex'",
        )
        .get(),
    ).toEqual({ status: "disconnected", secret: "" });
    expect(JSON.parse(saved.metadata)).toEqual({
      loop55Harness: "codex",
      authMode: "subscription",
      permissionMode: "bogus",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
