import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitProject } from "./git-project";
import { until } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "loop55-muse-native-"));
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_PROFILE = "companion";
process.env.LOOP55_TEST_MUSE_DIR = dir;
process.env.LOOP55_TEST_MUSE_LOG = join(dir, "requests");
writeFileSync(
  join(dir, "muse-credential.json"),
  JSON.stringify({ state: "accountLogin" }),
);
gitProject(dir);
const { db } = await import("../src/server/db");
const { NativeSessions, OWNER } = await import("../src/server/native-sessions");
const { createAgent, ownedConnection } = await import("../src/server/domain");
const { enqueue, claim, transition } = await import("../src/server/queue");
const { acceptsLiveInput } = await import("../src/server/native-connections");
const { eligibleMailAgent } = await import("../src/server/agent-mail-policy");
const { harnessName } = await import("../src/client/modelChoices");
const sessions = new NativeSessions();
afterAll(async () => {
  await sessions.close();
  db.close();
  delete process.env.LOOP55_TEST_MUSE_DIR;
  delete process.env.LOOP55_TEST_MUSE_LOG;
  rmSync(dir, { recursive: true, force: true });
});
const requests = () =>
  readFileSync(process.env.LOOP55_TEST_MUSE_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

it("registers Muse Code as a live-input native connection and resumes its generation-bound session", async () => {
  const registration = await sessions.enable({
    harness: "muse",
    executable: resolve("test/fixtures/fake-muse.mjs"),
    version: "1.4.12",
    project: dir,
    billing: "existing",
  });
  expect(registration.models.map((m: { id: string }) => m.id)).toContain(
    "muse-spark-fixture",
  );
  const connection = ownedConnection("native-muse", OWNER);
  expect(connection).toMatchObject({
    provider: "muse",
    secret: "",
    status: "connected",
    owner_id: OWNER,
  });
  expect(
    harnessName({
      ...connection,
      metadata: JSON.stringify(connection.metadata),
      models: JSON.stringify(connection.models),
    }),
  ).toBe("Muse Code");
  // Replies during a turn reach Muse through turn/steer, not the queue.
  expect(acceptsLiveInput(connection)).toBe(true);
  expect(connection.metadata).toMatchObject({
    loop55Harness: "muse",
    authMode: "native-existing",
  });
  // Registration checks the account and catalog only: no session, no prompt.
  expect(
    requests().some((r) => ["session/start", "turn/start"].includes(r.method)),
  ).toBe(false);
  const agent = createAgent(OWNER, {
    name: "muse-agent",
    connectionId: connection.id,
    model: "muse-spark-fixture",
    instructions: "Fixture instructions",
  });
  expect(eligibleMailAgent(OWNER, agent.id).id).toBe(agent.id);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('muse-conversation',?,?,'Muse',0)",
  ).run(OWNER, agent.id);
  const task = enqueue(OWNER, "Fixture", "muse-run", {
    conversation: "muse-conversation",
    agent: agent.id,
    payload: {
      agentId: agent.id,
      name: agent.name,
      provider: "muse",
      folderId: null,
      connectionId: connection.id,
      model: "muse-spark-fixture",
      instructions: "Fixture instructions",
    },
  });
  const first = await sessions.session(task);
  expect(first.binding.harness).toBe("muse");
  const saved = db
    .prepare(
      "SELECT native_id,generation FROM companion_sessions WHERE conversation_id='muse-conversation'",
    )
    .get() as any;
  expect(saved.native_id).toBe("01a16dbe-0000-7000-8000-000000000001");
  await sessions.dispose(first);
  const resumed = await sessions.session(task);
  expect(resumed.generation).not.toBe(saved.generation);
  expect(
    requests().find((r) => r.method === "session/resume")?.params.sessionId,
  ).toBe(saved.native_id);
  // Neither creation nor resume replays work.
  expect(requests().filter((r) => r.method === "turn/start")).toEqual([]);
  await resumed.adapter.prompt("Explicit follow-up after restart");
  await until(() => requests().some((r) => r.method === "turn/start"));
  expect(
    requests()
      .filter((r) => r.method === "turn/start")
      .map((r) => r.params.input[0].text),
  ).toEqual(["Fixture instructions\n\nExplicit follow-up after restart"]);
  await sessions.dispose(resumed);
});

it("records a model reported during startup on the native-default run and catalog", async () => {
  const agent = createAgent(OWNER, {
    name: "muse-default",
    connectionId: "native-muse",
    model: "native-default",
    instructions: "",
  });
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('muse-default',?,?,'Muse',0)",
  ).run(OWNER, agent.id);
  const task = enqueue(OWNER, "Which model?", "muse-default-run", {
    conversation: "muse-default",
    agent: agent.id,
    payload: {
      agentId: agent.id,
      name: agent.name,
      provider: "muse",
      folderId: null,
      connectionId: "native-muse",
      model: "native-default",
      instructions: "",
    },
  });
  // The fixture reuses one Muse session id; release the earlier binding.
  db.prepare(
    "DELETE FROM companion_sessions WHERE conversation_id='muse-conversation'",
  ).run();
  const claimed = claim("muse-fixture", (run) => run.id === task.id)!;
  // Muse reports its model while the session starts, before the turn is
  // attached; the run still records it.
  if ((await sessions.execute(claimed)) !== false)
    transition(claimed, "completed");
  const payload = JSON.parse(
    (
      db.prepare("SELECT payload FROM runs WHERE id=?").get(task.id) as {
        payload: string;
      }
    ).payload,
  );
  expect(payload).toMatchObject({
    model: "native-default",
    resolvedModel: "muse-spark-fixture",
  });
  expect(
    ownedConnection("native-muse", OWNER).models.find(
      (model: { id: string }) => model.id === "native-default",
    ),
  ).toMatchObject({ resolvedModel: "muse-spark-fixture" });

  // A model chosen in session settings is applied at the next prompt, after
  // the startup report; that report must not be recorded for the turn.
  const controls = sessions.controls("muse-default");
  await sessions.setSetting(
    "muse-default",
    "model",
    "muse-other-fixture",
    controls.settings.revision,
    controls.generation!,
  );
  const next = enqueue(OWNER, "And now?", "muse-default-next", {
    conversation: "muse-default",
    agent: agent.id,
    payload: {
      agentId: agent.id,
      name: agent.name,
      provider: "muse",
      folderId: null,
      connectionId: "native-muse",
      model: "native-default",
      instructions: "",
    },
  });
  await sessions.execute(claim("muse-fixture", (run) => run.id === next.id)!);
  expect(
    JSON.parse(
      (
        db.prepare("SELECT payload FROM runs WHERE id=?").get(next.id) as {
          payload: string;
        }
      ).payload,
    ).resolvedModel,
  ).toBeUndefined();
});
