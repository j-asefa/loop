import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";

const dir = mkdtempSync(join(tmpdir(), "loop-hapi-review-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_HAPI_URL = "http://fixture";
process.env.LOOP_HAPI_TOKEN = "fixture";
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
vi.mock("../src/server/hapi/environments", async (original) => ({
  ...(await original<any>()),
  workerRequest: vi.fn(async (_e, path) => {
    const auth = {
      authenticated: true,
      managed: true,
      checkedAt: Date.now(),
      authMethod: "chatgpt",
    };
    return path === "/prepare" ? { auth } : auth;
  }),
}));
const { db, id, now } = await import("../src/server/db");
const { provisionEnvironment, workerRequest } =
  await import("../src/server/hapi/environments");
const { billingPolicy } = await import("../src/server/hapi/contracts");
const {
  ensureSession,
  executeHapi,
  dispatchFor,
  nativeCancel,
  nativeDecision,
  reconcile,
} = await import("../src/server/hapi/adapter");
const { HapiClient, InactiveSessionError } =
  await import("../src/server/hapi/client");
const { createAgent } = await import("../src/server/domain");
const { submit } = await import("../src/server/agent-runtime");
const { memoryRoutes, readMemory, captureMemory } =
  await import("../src/server/memory");
const { executionRoutes, connectProvider } =
  await import("../src/server/hapi/routes");
const host = provisionEnvironment("alice", {
  name: "Review fixture",
  url: "https://worker.invalid:3010",
  instanceId: "i-1234567890abcdef0",
  namespace: "review",
  credential: "a".repeat(48),
  certificateFingerprint: "AB:".repeat(31) + "AB",
});
const project = id(),
  connection = id();
db.prepare(
  "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,'alice','project','Review',?)",
).run(project, now());
db.prepare(
  "INSERT INTO environment_projects(environment_id,project_id,canonical_path) VALUES(?,?,?)",
).run(host, project, dir);
db.prepare(
  "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'alice','codex','Review','','connected','[{\"id\":\"fixture\"}]',?,?)",
).run(
  connection,
  JSON.stringify({
    backend: "hapi",
    environmentId: host,
    flavor: "codex",
    billing: billingPolicy,
  }),
  now(),
);
const agent = createAgent("alice", {
  name: "review",
  connectionId: connection,
  model: "fixture",
});
db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(project, agent.id);
function fixture(agentId = agent.id) {
  const run = submit("alice", {
    agentId,
    input: "fixture " + id(),
    idempotencyKey: id(),
  });
  const s = ensureSession(run);
  s.hub_session_id = id();
  db.prepare(
    "UPDATE native_sessions SET hub_session_id=?,state='inactive' WHERE conversation_id=?",
  ).run(s.hub_session_id, s.conversation_id);
  return { run, s };
}
const app = express();
app.use(express.json(), (_req, res, next) => {
  res.locals.owner = "alice";
  next();
});
app.use(memoryRoutes, executionRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
async function api(path: string, method = "GET", body?: any) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('defers a confirmed runner maintenance refusal without a spawn/send or uncertain receipt', async () => {
  const { run } = fixture();
  vi.mocked(workerRequest).mockResolvedValueOnce({ deferred:'runtime-maintenance' });
  const request = vi.spyOn(HapiClient.prototype,'request');
  await expect(executeHapi(run)).rejects.toThrow('held for maintenance');
  expect(dispatchFor(run.id)).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});

it('fences managed upgrade recovery by the environment generation and requires explicit confirmation', async () => {
  const commandId = id();
  const generation = (db.prepare('SELECT generation FROM execution_environments WHERE host_id=?').get(host) as any).generation;
  db.prepare("UPDATE execution_environments SET state='online' WHERE host_id=?").run(host);
  const path = `/environments/${host}/runtimes/codex/upgrade/recover`;
  vi.mocked(workerRequest).mockClear();
  expect((await api(path,'POST',{generation:generation+1,confirmedStopped:true,commandId})).status).toBe(409);
  expect((await api(path,'POST',{generation,confirmedStopped:false,commandId})).status).toBe(500);
  expect(workerRequest).not.toHaveBeenCalled();
  expect((await api(path,'POST',{generation,confirmedStopped:true,commandId})).status).toBe(200);
  expect(workerRequest).toHaveBeenCalledWith(expect.objectContaining({host_id:host}),'/runtime/upgrade/recover',{
    generation,confirmedStopped:true,commandId,flavor:'codex',
  });
});

it("defers inactive sends without taking a delivery lease and permits explicit resume", async () => {
  const { run, s } = fixture();
  let active = false;
  const request = vi
    .spyOn(HapiClient.prototype, "request")
    .mockImplementation(async (path) => {
      if (path.endsWith("/resume")) {
        active = true;
        return { sessionId: s.hub_session_id };
      }
      if (path.includes("/messages?"))
        return {
          messages: [],
          page: {
            epoch: 1,
            snapshotHeadSeq: 0,
            snapshotHeadAt: 0,
            hasMore: false,
          },
        };
      if (path.endsWith("/queued-state"))
        return { invokedLocalMessages: [], queuedLocalIds: [] };
      if (path.endsWith("/messages")) return { ok: true };
      return { session: { active, agentState: {} } };
    });
  await executeHapi(run);
  expect(dispatchFor(run.id)).toMatchObject({
    state: "blocked",
    send_started_at: null,
  });
  expect(request.mock.calls.some(([path]) => path.endsWith("/messages"))).toBe(
    false,
  );
  expect(
    (await api(`/conversations/${s.conversation_id}/resume-native`, "POST", {}))
      .status,
  ).toBe(200);
  expect(dispatchFor(run.id)?.state).toBe("accepted");
});

it("clears the lease only for a confirmed inactive rejection, not transport uncertainty", async () => {
  for (const confirmed of [true, false]) {
    const { run } = fixture();
    vi.spyOn(HapiClient.prototype, "request").mockImplementation(
      async (path) => {
        if (path.endsWith("/messages"))
          throw confirmed
            ? new InactiveSessionError()
            : new Error("connection reset");
        return { session: { active: true } };
      },
    );
    await executeHapi(run);
    const d = dispatchFor(run.id)!;
    expect(d.state).toBe(confirmed ? "blocked" : "delivery-unknown");
    expect(d.send_started_at === null).toBe(confirmed);
    vi.restoreAllMocks();
  }
});

it("recognizes the pinned Hub's explicit inactive rejection", async () => {
  const client = new HapiClient(
    "http://fixture",
    "fixture",
    (async (url: any) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/auth")
            ? { token: "fixture" }
            : { code: "session_inactive" },
        ),
        { status: String(url).endsWith("/auth") ? 200 : 409 },
      )) as typeof fetch,
  );
  await expect(
    client.request("/api/sessions/test/messages", {}),
  ).rejects.toBeInstanceOf(InactiveSessionError);
});

it("does not reopen or abort terminal dispatches when cancellation is retried", async () => {
  const { run } = fixture();
  const request = vi
    .spyOn(HapiClient.prototype, "request")
    .mockResolvedValue({ session: { active: true }, ok: true });
  await executeHapi(run);
  for (const state of ["completed", "failed", "cancelled"]) {
    db.prepare("UPDATE native_dispatches SET state=? WHERE run_id=?").run(
      state,
      run.id,
    );
    request.mockClear();
    expect(await nativeCancel(run)).toBe(true);
    expect(dispatchFor(run.id)?.state).toBe(state);
    expect(request).not.toHaveBeenCalled();
  }
});

it("reconciles submitted decisions with the original answers after transport failure", async () => {
  const { run, s } = fixture();
  const request = vi
    .spyOn(HapiClient.prototype, "request")
    .mockResolvedValue({ session: { active: true }, ok: true });
  await executeHapi(run);
  const approval = id(),
    requestId = id(),
    answers = { choice: ["Keep"] };
  db.prepare(
    "INSERT INTO approvals(id,owner_id,run_id,request,digest,state,expires_at,created_at) VALUES(?,'alice',?,'{}','fixture','pending',?,?)",
  ).run(approval, run.id, now() + 60000, now());
  db.prepare(
    "INSERT INTO native_permissions(approval_id,conversation_id,hub_session_id,request_id) VALUES(?,?,?,?)",
  ).run(approval, s.conversation_id, s.hub_session_id, requestId);
  request.mockRejectedValueOnce(new Error("connection reset"));
  await expect(
    nativeDecision("alice", approval, "approve", answers),
  ).rejects.toThrow("connection reset");
  expect(
    db
      .prepare(
        "SELECT state,answers FROM native_permissions WHERE approval_id=?",
      )
      .get(approval),
  ).toEqual({ state: "submitted", answers: JSON.stringify(answers) });
  let completed = false;
  request.mockImplementation(async (path) => {
    if (path.includes("/messages?"))
      return {
        messages: [],
        page: {
          epoch: 1,
          snapshotHeadSeq: 0,
          snapshotHeadAt: 0,
          hasMore: false,
        },
      };
    if (path.endsWith("/queued-state"))
      return {
        invokedLocalMessages: [],
        queuedLocalIds: [dispatchFor(run.id)!.local_id],
      };
    if (path.includes("/permissions/")) return { ok: true };
    return {
      session: {
        active: true,
        agentState: completed
          ? { completedRequests: { [requestId]: { decision: "approved" } } }
          : { requests: { [requestId]: {} } },
      },
    };
  });
  await reconcile(s);
  expect(request).toHaveBeenCalledWith(
    `/api/sessions/${s.hub_session_id}/permissions/${requestId}/approve`,
    { decision: "approved", answers },
  );
  completed = true;
  request.mockClear();
  await reconcile(s);
  expect(
    request.mock.calls.some(([path]) => path.includes("/permissions/")),
  ).toBe(false);
  expect(
    (
      db
        .prepare("SELECT state FROM native_permissions WHERE approval_id=?")
        .get(approval) as any
    ).state,
  ).toBe("resolved");
});

it("loads and saves all 20,000 note characters while keeping recall bounded", async () => {
  const content = "n".repeat(20000);
  const created = await api("/memory/notes", "POST", {
    title: "Before",
    content,
  });
  const note = (await api("/memory/sources/" + created.data.id)).data;
  expect(note.content).toBe(content);
  expect(readMemory("alice", note.id).content).toHaveLength(12000);
  expect(
    (
      await api("/memory/notes/" + note.id, "PATCH", {
        title: "After",
        content: note.content,
        revision: note.revision,
      })
    ).status,
  ).toBe(200);
  expect((await api("/memory/sources/" + note.id)).data.content).toBe(content);
});

it("policy toggles preserve intrinsic exclusion of partial and failed assistant output", async () => {
  for (const partial of [true, false]) {
    const { run, s } = fixture();
    db.prepare("UPDATE runs SET state=? WHERE id=?").run(
      partial ? "completed" : "failed",
      run.id,
    );
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,'alice',?,?,'assistant',?,?,?)",
    ).run(
      id(),
      s.conversation_id,
      run.id,
      "unsafe " + partial,
      JSON.stringify({ partial }),
      now(),
    );
    captureMemory();
    for (const scope of [
      "workspace",
      "project:" + project,
      "conversation:" + s.conversation_id,
    ]) {
      await api("/memory/policy", "PUT", { scope, enabled: false });
      await api("/memory/policy", "PUT", { scope, enabled: true });
    }
    const sources = db
      .prepare(
        "SELECT * FROM memory_sources WHERE conversation_id=? AND role='assistant'",
      )
      .all(s.conversation_id) as any[];
    expect(sources).toHaveLength(1);
    for (const source of sources) {
      expect(source.eligible).toBe(0);
      expect(() => readMemory("alice", source.id)).toThrow();
      expect(
        (
          db
            .prepare("SELECT action FROM memory_outbox WHERE source_id=?")
            .get(source.id) as any
        ).action,
      ).toBe("delete");
    }
  }
});

it("sends each thread's MCP credential across the process boundary in its own config", async () => {
  const { managedThread } = await import("../native/loopManaged");
  const old = {
    managed: process.env.LOOP_MANAGED,
    file: process.env.LOOP_LAUNCH_FILE,
    generation: process.env.LOOP_ENVIRONMENT_GENERATION,
  };
  try {
    process.env.LOOP_MANAGED = "1";
    process.env.LOOP_ENVIRONMENT_GENERATION = "1";
    process.env.LOOP_LAUNCH_FILE = join(dir, "binding.json");
    for (const token of ["conversation-one", "conversation-two"]) {
      writeFileSync(
        process.env.LOOP_LAUNCH_FILE,
        JSON.stringify({
          generation: 1,
          gatewayUrl: "http://fixture/mcp",
          gatewayToken: token,
        }),
      );
      const config = managedThread({}).config["mcp_servers.loop"];
      expect(config.http_headers).toEqual({ Authorization: "Bearer " + token });
      expect(config.bearer_token_env_var).toBeUndefined();
    }
  } finally {
    for (const [key, value] of Object.entries({
      LOOP_MANAGED: old.managed,
      LOOP_LAUNCH_FILE: old.file,
      LOOP_ENVIRONMENT_GENERATION: old.generation,
    }))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

function snapshotMock(s: any, agentState: () => any = () => ({})) {
  return vi
    .spyOn(HapiClient.prototype, "request")
    .mockImplementation(async (path) => {
      if (path.includes("/messages?"))
        return {
          messages: [],
          page: {
            epoch: 1,
            snapshotHeadSeq: 0,
            snapshotHeadAt: 0,
            hasMore: false,
          },
        };
      if (path.endsWith("/queued-state"))
        return { invokedLocalMessages: [], queuedLocalIds: [] };
      return { ok: true, session: { active: true, agentState: agentState() } };
    });
}
it("keeps concurrent approvals visible until every request resolves", async () => {
  const { run, s } = fixture();
  let state: any = {};
  snapshotMock(s, () => state);
  await executeHapi(run);
  db.prepare("UPDATE runs SET state='running' WHERE id=?").run(run.id);
  state = { requests: { first: { tool: "Bash" }, second: { tool: "Bash" } } };
  await reconcile(s);
  state = {
    requests: { second: { tool: "Bash" } },
    completedRequests: { first: {} },
  };
  await reconcile(s);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "awaiting_approval",
  });
  await reconcile(s);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "awaiting_approval",
  });
  state = { completedRequests: { first: {}, second: {} } };
  await reconcile(s);
  expect(db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "running",
  });
});
it.each(["retry", "reconcile"])(
  "recovers failed cancellation through %s without aborting terminal work",
  async (mode) => {
    const { run, s } = fixture();
    const request = snapshotMock(s);
    await executeHapi(run);
    request.mockRejectedValueOnce(new Error("unavailable"));
    await expect(nativeCancel(run)).rejects.toThrow("unavailable");
    request.mockClear();
    if (mode === "retry") await nativeCancel(run);
    else await reconcile(s);
    expect(
      request.mock.calls.filter(([p]) => p.endsWith("/abort")),
    ).toHaveLength(1);
    db.prepare(
      "UPDATE native_dispatches SET state='completed' WHERE run_id=?",
    ).run(run.id);
    request.mockClear();
    await nativeCancel(run);
    await reconcile(s);
    expect(
      request.mock.calls.filter(([p]) => p.endsWith("/abort")),
    ).toHaveLength(0);
  },
);
it("cancels before the send lease without sending and requests abort after the lease", async () => {
  for (const sendWins of [false, true]) {
    const { run, s } = fixture();
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const request = vi
      .spyOn(HapiClient.prototype, "request")
      .mockImplementation(async (path) => {
        if (
          sendWins
            ? path.endsWith("/messages")
            : path === "/api/sessions/" + s.hub_session_id
        ) {
          reached();
          await gate;
        }
        return { ok: true, session: { active: true } };
      });
    const sending = executeHapi(run);
    await ready;
    await nativeCancel(run);
    release();
    await sending;
    expect(dispatchFor(run.id)?.state).toBe(
      sendWins ? "cancellation-requested" : "cancelled",
    );
    expect(request.mock.calls.some(([p]) => p.endsWith("/messages"))).toBe(
      sendWins,
    );
    expect(request.mock.calls.some(([p]) => p.endsWith("/abort"))).toBe(
      sendWins,
    );
    vi.restoreAllMocks();
  }
});
it("uses positional Claude keys and Codex question IDs", async () => {
  const { nativeQuestionKey } = await import("../src/shared/native-questions");
  expect(nativeQuestionKey("AskUserQuestion", {}, 0)).toBe("0");
  expect(nativeQuestionKey("AskUserQuestion", {}, 1)).toBe("1");
  expect(nativeQuestionKey("request_user_input", { id: "choice" }, 0)).toBe(
    "choice",
  );
});

it.each([false, true])(
  "holds cancelled spawn ownership until attachment (observer first: %s)",
  async (observerFirst) => {
    const { claim } = await import("../src/server/queue");
    const { sessionFor } = await import("../src/server/hapi/adapter");
    // Isolate the real queue from queued fixtures belonging to earlier tests.
    db.prepare("UPDATE runs SET state='paused' WHERE state='queued'").run();
    db.prepare(
      "UPDATE execution_environments SET state='online',last_seen=? WHERE host_id=?",
    ).run(now(), host);
    const spawnAgent = createAgent("alice", {
      name: "spawn-review-" + observerFirst,
      connectionId: connection,
      model: "fixture",
    });
    db.prepare("UPDATE agents SET folder_id=? WHERE id=?").run(
      project,
      spawnAgent.id,
    );
    const { run, s } = fixture(spawnAgent.id);
    db.prepare(
      "UPDATE native_sessions SET hub_session_id=NULL WHERE conversation_id=?",
    ).run(s.conversation_id);
    s.hub_session_id = null;
    expect(claim("spawn-review")?.id).toBe(run.id);
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const request = snapshotMock(s);
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (path, body) => {
      if (path.endsWith("/spawn")) {
        reached();
        await gate;
        return { type: "success", sessionId: "cancelled-spawn" };
      }
      if (path === "/api/sessions")
        return {
          sessions: [
            { id: "cancelled-spawn", metadata: { loopLaunchId: s.launch_id } },
          ],
        };
      return fallback(path, body);
    });
    const spawning = executeHapi(run);
    await ready;
    await nativeCancel(run);
    expect(dispatchFor(run.id)?.state).toBe("cancellation-requested");
    const next = submit("alice", {
      agentId: spawnAgent.id,
      conversationId: s.conversation_id,
      input: "next",
      idempotencyKey: id(),
    });
    expect(claim("next-review")).toBeUndefined();
    if (observerFirst) {
      await reconcile(sessionFor(s.conversation_id)!);
      expect(dispatchFor(run.id)?.state).toBe("cancelled");
      // A subsequent verified lineage change must survive the old spawn response.
      db.prepare(
        "UPDATE native_sessions SET hub_session_id='replacement' WHERE conversation_id=?",
      ).run(s.conversation_id);
    }
    release();
    await spawning;
    expect(dispatchFor(run.id)?.state).toBe("cancelled");
    expect(
      request.mock.calls.some(
        ([p]) => p.endsWith("/messages") || p.endsWith("/abort"),
      ),
    ).toBe(false);
    expect(claim("next-review")?.id).toBe(next.id);
    await executeHapi(next);
    const target = observerFirst ? "replacement" : "cancelled-spawn";
    expect(request).toHaveBeenCalledWith(
      `/api/sessions/${target}/messages`,
      expect.anything(),
    );
    expect(sessionFor(s.conversation_id)?.hub_session_id).toBe(target);
  },
);

it.each([true, false])(
  "handles cancellation during send rejection (definite: %s)",
  async (confirmed) => {
    const { run, s } = fixture();
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const request = snapshotMock(s);
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (path, body) => {
      if (path.endsWith("/messages")) {
        reached();
        await gate;
        throw confirmed
          ? new InactiveSessionError()
          : new Error("connection reset");
      }
      if (path.endsWith("/abort")) throw new InactiveSessionError();
      if (path.endsWith("/resume")) return { sessionId: s.hub_session_id };
      return fallback(path, body);
    });
    const sending = executeHapi(run);
    await ready;
    await expect(nativeCancel(run)).rejects.toBeInstanceOf(
      InactiveSessionError,
    );
    release();
    await sending;
    expect(dispatchFor(run.id)?.state).toBe(
      confirmed ? "cancelled" : "cancellation-requested",
    );
    expect(dispatchFor(run.id)?.send_started_at === null).toBe(confirmed);
    expect(
      (
        await api(
          `/conversations/${s.conversation_id}/resume-native`,
          "POST",
          {},
        )
      ).status,
    ).toBe(confirmed ? 200 : 409);
  },
);

it.each(["running", "awaiting_approval"])(
  "queues HAPI follow-ups while the previous turn is %s",
  (state) => {
    const { run } = fixture();
    db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, run.id);
    const request = {
      agentId: agent.id,
      conversationId: run.conversation_id!,
      input: "Follow up after this turn",
      idempotencyKey: id(),
      steer: true,
    };
    const next = submit("alice", request);
    expect(next.id).not.toBe(run.id);
    expect(next.state).toBe("queued");
    expect(next.conversation_id).toBe(run.conversation_id);
    expect(submit("alice", request).id).toBe(next.id);
    expect(
      db.prepare("SELECT 1 FROM run_steering WHERE run_id=?").get(run.id),
    ).toBeUndefined();
  },
);

it("persists attachments and quoted replies in the exact HAPI delivery envelope", async () => {
  const { uploadFile } = await import("../src/server/uploads");
  const { digest } = await import("../src/server/hapi/contracts");
  const { run: previous } = fixture();
  const quoted = { id: id() };
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    quoted.id,
    "alice",
    previous.conversation_id,
    previous.id,
    "assistant",
    "Earlier assistant answer",
    "{}",
    now(),
  );
  const file = uploadFile("alice", {
    originalname: "review-context.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("Selected file contents"),
  });
  const run = submit("alice", {
    agentId: agent.id,
    conversationId: previous.conversation_id!,
    input: "Use this file to answer the quoted message",
    attachmentIds: [file.id],
    replyToMessageId: quoted.id,
    idempotencyKey: id(),
  });
  let sent: any;
  vi.spyOn(HapiClient.prototype, "request").mockImplementation(
    async (path, options) => {
      if (path.endsWith("/messages")) {
        sent = options;
        return { ok: true };
      }
      return { session: { active: true } };
    },
  );
  await executeHapi(run);
  const dispatch = dispatchFor(run.id)!;
  expect(dispatch.envelope).toContain(file.name);
  expect(dispatch.envelope).toContain(file.id);
  expect(dispatch.envelope).toContain("> Earlier assistant answer");
  expect(dispatch.envelope).toContain(run.input);
  expect(
    (
      db
        .prepare("SELECT payload_hash FROM native_dispatches WHERE run_id=?")
        .get(run.id) as { payload_hash: string }
    ).payload_hash,
  ).toBe(digest(dispatch.envelope));
  expect(sent).toEqual({ text: dispatch.envelope, localId: dispatch.local_id });
  expect(JSON.stringify(sent)).toContain(file.id);
  expect(dispatch.state).toBe("accepted");
});

it("connects OpenCode only with guarded runner evidence and preserves its identity", async () => {
  const { workerRequest } = await import("../src/server/hapi/environments");
  db.prepare("UPDATE execution_environments SET state='online' WHERE host_id=?").run(host);
  const { environment } = await import("../src/server/hapi/environments");
  const e = { ...environment("alice", host), name: "Fixture" };
  await expect(connectProvider(e, "opencode")).rejects.toThrow(
    "must be verified",
  );
  vi.mocked(workerRequest).mockResolvedValueOnce({
    authenticated: true,
    managed: true,
    checkedAt: Date.now(),
    authMethod: "chatgpt",
    executionGuard: "loop-subscription-v1",
    models: [{ id: "openai/gpt-5.4" }],
  });
  const connection = await connectProvider(e, "opencode");
  const saved = db
    .prepare("SELECT * FROM connections WHERE id=? AND owner_id='alice'")
    .get(connection.id) as any;
  expect(saved.provider).toBe("opencode");
  expect(saved.label).toBe("Fixture · opencode (ChatGPT)");
  expect(JSON.parse(saved.metadata)).toMatchObject({
    flavor: "opencode",
    billing: billingPolicy,
  });
  expect(JSON.parse(saved.models)).toEqual([{ id: "openai/gpt-5.4" }]);
});


it("connects Pi with existing billing only and rejects subscription evidence", async () => {
  const { workerRequest } = await import("../src/server/hapi/environments");
  const { piPolicy, connectionSelection } = await import("../src/server/hapi/contracts");
  db.prepare("UPDATE execution_environments SET state='online' WHERE host_id=?").run(host);
  const { environment } = await import("../src/server/hapi/environments");
  const e = { ...environment("alice", host), name: "Fixture" };
  const evidence = { authenticated: true, managed: true, checkedAt: Date.now(), authMethod: "existing", models: [{ id: "openai/gpt-5.4" }] };
  for (const invalid of [{ ...evidence, authMethod: "chatgpt" }, { ...evidence, managed: false }, { ...evidence, checkedAt: 0 }, { ...evidence, authenticated: false }]) {
    vi.mocked(workerRequest).mockResolvedValueOnce(invalid);
    await expect(connectProvider(e, "pi")).rejects.toThrow("must be verified");
  }
  vi.mocked(workerRequest).mockResolvedValueOnce(evidence);
  const connection = await connectProvider(e, "pi");
  const saved = db.prepare("SELECT * FROM connections WHERE id=? AND owner_id='alice'").get(connection.id) as any;
  expect(saved.provider).toBe("pi");
  expect(saved.label).toBe("Fixture · Pi");
  expect(JSON.parse(saved.metadata)).toMatchObject({ flavor: "pi", authMode: "existing", billing: piPolicy });
  expect(connectionSelection(saved)?.billing).toEqual(piPolicy);
  for (const billing of [billingPolicy, { ...piPolicy, allowApiFallback: true }]) {
    expect(() => connectionSelection({ metadata: JSON.stringify({ ...JSON.parse(saved.metadata), billing }) })).toThrow();
  }
});


it("fences connection registration when the runner changes during authentication", async () => {
  const { environment, workerRequest } = await import("../src/server/hapi/environments");
  for (const change of ["generation=generation+1", "state='offline'", "revoked_at='fixture'"]) {
    db.prepare("UPDATE execution_environments SET state='online',revoked_at=NULL WHERE host_id=?").run(host);
    const e = environment("alice", host);
    const before = db.prepare("SELECT * FROM connections ORDER BY id").all();
    vi.mocked(workerRequest).mockImplementationOnce(async () => {
      db.prepare(`UPDATE execution_environments SET ${change} WHERE host_id=?`).run(host);
      return { authenticated: true, managed: true, checkedAt: Date.now(), authMethod: "chatgpt" };
    });
    await expect(connectProvider(e, "codex")).rejects.toThrow(/changed|revoked/);
    expect(db.prepare("SELECT * FROM connections ORDER BY id").all()).toEqual(before);
  }
  db.prepare("UPDATE execution_environments SET state='online',revoked_at=NULL WHERE host_id=?").run(host);
});
