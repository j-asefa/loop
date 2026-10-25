import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitProject } from "./git-project";
import { until } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "loop-gemini-native-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_PROFILE = "companion";
process.env.LOOP_TEST_GEMINI_LOG = join(dir, "requests");
gitProject(dir);
const { db } = await import("../src/server/db");
const { NativeSessions, OWNER } = await import("../src/server/native-sessions");
const { createAgent, ownedConnection } = await import("../src/server/domain");
const { enqueue } = await import("../src/server/queue");
const { acceptsLiveInput } = await import("../src/server/native-connections");
const { eligibleMailAgent } = await import("../src/server/agent-mail-policy");
const { harnessName } = await import("../src/client/modelChoices");
const sessions = new NativeSessions();
afterAll(async () => {
  await sessions.close();
  db.close();
  delete process.env.LOOP_TEST_GEMINI_LOG;
  rmSync(dir, { recursive: true, force: true });
});
it("registers Gemini separately from custom ACP, creates an agent and resumes its generation-bound native session", async () => {
  const registration = await sessions.enable({
    harness: "gemini",
    executable: resolve("test/fixtures/fake-gemini.mjs"),
    version: "0.64.0",
    project: dir,
    billing: "existing",
  });
  expect(registration.models).toContainEqual({
    id: "gemini-fixture",
    name: "Gemini fixture",
  });
  const connection = ownedConnection("native-gemini", OWNER);
  expect(connection).toMatchObject({
    provider: "gemini",
    secret: "",
    status: "connected",
    owner_id: OWNER,
  });
  expect(harnessName({ ...connection, metadata: JSON.stringify(connection.metadata), models: JSON.stringify(connection.models) })).toBe("Gemini CLI");
  expect(acceptsLiveInput(connection)).toBe(false);
  expect(connection.metadata).toMatchObject({
    loopHarness: "gemini",
    authMode: "native-existing",
    capabilities: { billingVerified: false },
  });
  const agent = createAgent(OWNER, {
    name: "gemini-agent",
    connectionId: connection.id,
    model: "gemini-fixture",
    instructions: "Fixture instructions",
  });
  expect(eligibleMailAgent(OWNER, agent.id).id).toBe(agent.id);
  expect(() => eligibleMailAgent("another-owner", agent.id)).toThrow(
    /not found/,
  );
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('gemini-conversation',?,?,'Gemini',0)",
  ).run(OWNER, agent.id);
  const task = enqueue(OWNER, "Fixture", "gemini-run", {
    conversation: "gemini-conversation",
    agent: agent.id,
    payload: {
      agentId: agent.id, name: agent.name, provider: "gemini", folderId: null,
      connectionId: connection.id,
      model: "gemini-fixture",
      instructions: "Fixture instructions",
    },
  });
  const first = await sessions.session(task);
  expect(first.binding.harness).toBe("gemini");
  const saved = db
    .prepare(
      "SELECT native_id,generation,project FROM companion_sessions WHERE conversation_id='gemini-conversation'",
    )
    .get() as any;
  expect(saved.native_id).toBe("gemini-session");
  expect(saved.project).not.toBe(dir);
  await sessions.dispose(first);
  const resumed = await sessions.session(task);
  expect(resumed.generation).not.toBe(saved.generation);
  expect(readFileSync(process.env.LOOP_TEST_GEMINI_LOG!, "utf8")).toContain(
    '"method":"session/load"',
  );
  const requests = () =>
    readFileSync(process.env.LOOP_TEST_GEMINI_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  // Session creation and reload must not replay the interrupted run. The
  // first explicitly sent follow-up still needs the saved agent instructions.
  expect(
    requests().filter((request) => request.method === "session/prompt"),
  ).toEqual([]);
  await resumed.adapter.prompt("Explicit follow-up after restart");
  await until(() =>
    requests().some((request) => request.method === "session/prompt"),
  );
  expect(
    requests()
      .filter((request) => request.method === "session/prompt")
      .map((request) => request.params.prompt[0].text),
  ).toEqual(["Fixture instructions\n\nExplicit follow-up after restart"]);
  await sessions.dispose(resumed);
});

it("switches an existing Gemini conversation from an explicit model back to the CLI default", async () => {
  await sessions.enable({
    harness: "gemini",
    executable: resolve("test/fixtures/fake-gemini.mjs"),
    version: "0.64.0",
    project: dir,
    billing: "existing",
  });
  const agent = createAgent(OWNER, {
    name: "gemini-model-agent",
    connectionId: "native-gemini",
    model: "gemini-fixture",
    instructions: "Model fixture instructions",
  });
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('gemini-model-conversation',?,?,'Models',0)",
  ).run(OWNER, agent.id);
  const task = enqueue(OWNER, "Model fixture", "gemini-model-run", {
    conversation: "gemini-model-conversation",
    agent: agent.id,
    payload: {
      agentId: agent.id, name: agent.name, provider: "gemini", folderId: null,
      connectionId: "native-gemini",
      model: "gemini-fixture",
      instructions: "Model fixture instructions",
    },
  });
  const prompts = () =>
    readFileSync(process.env.LOOP_TEST_GEMINI_LOG!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        (request) =>
          request.method === "session/prompt" &&
          request.params.prompt[0].text.startsWith("Model fixture instructions"),
      );
  process.env.LOOP_TEST_GEMINI_AUTO = "1";
  process.env.LOOP_TEST_GEMINI_SESSION_ID = "gemini-model-session";
  try {
    const selected = await sessions.session(task);
    await selected.adapter.prompt("Use selected model");
    await until(() => prompts().length === 1);
    expect(prompts()[0].fixtureModelId).toBe("gemini-fixture");
    const nativeId = selected.binding.native_id;
    const defaultSession = await sessions.session({
      ...task,
      payload: {
        ...task.payload,
        model: "native-default",
      },
    });
    expect(selected.closed).toBe(true);
    expect(defaultSession.generation).not.toBe(selected.generation);
    expect(defaultSession.binding.native_id).toBe(nativeId);
    expect(defaultSession.binding.model).toBeNull();
    expect(prompts()).toHaveLength(1);
    await defaultSession.adapter.prompt("Use native default");
    await until(() => prompts().length === 2);
    expect(prompts()[1].fixtureModelId).toBe("gemini-default-fixture");
    await sessions.dispose(defaultSession);
  } finally {
    delete process.env.LOOP_TEST_GEMINI_AUTO;
    delete process.env.LOOP_TEST_GEMINI_SESSION_ID;
  }
});
