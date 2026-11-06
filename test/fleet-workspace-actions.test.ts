import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { Host } from "../src/host.js";
import { applyMigrations } from "../src/server/migrations.js";
import { FleetAuthority } from "../src/server/fleet-authority.js";
import { FleetCredentials } from "../src/server/fleet-credentials.js";
import { FleetPairing } from "../src/server/fleet-pairing.js";
import { FleetEnrollmentDestination } from "../src/server/fleet-enrollment.js";
import { FleetWorkspaceApp } from "../src/server/fleet-workspace-app.js";
import { FleetWorkspaceActions } from "../src/server/fleet-workspace-actions.js";
import { verifyFleetProof } from "../src/server/fleet-proof.js";
import {
  directoryDigest,
  fleetPayloadDigest,
} from "../src/server/fleet-crypto.js";
import { fleetWorkspaceActionApi } from "../src/shared/fleet-workspace-action-api.js";

const root = mkdtempSync(join(tmpdir(), "loop-fleet-actions-"));
process.env.LOOP_DATA_DIR = join(root, "destination");
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
mkdirSync(process.env.LOOP_DATA_DIR);
const { app } = await import("../src/server/index.js");
const { db } = await import("../src/server/db.js");
const { OWNER, nativeSessions } =
  await import("../src/server/native-sessions.js");
const { closeExecution } = await import("../src/server/execution-client.js");
const { enqueue, transition } = await import("../src/server/queue.js");
const { ownedRun } = await import("../src/server/domain.js");
const { createFleetPeerHttp } =
  await import("../src/server/fleet-peer-http.js");
const secrets = await import("../src/server/secrets.js");
const sourceDb = new Database(join(root, "source.db"));
applyMigrations(sourceDb);
sourceDb.prepare("INSERT INTO deployment_profile VALUES(1,'companion')").run();
const source = new FleetAuthority(sourceDb, secrets),
  destination = new FleetAuthority(db, secrets),
  credentials = new FleetCredentials(db, destination, secrets),
  sourceCredentials = new FleetCredentials(sourceDb, source, secrets),
  sourceOwner = randomUUID(),
  origin = "https://destination.example";
const first = source.create(sourceOwner, {
  mutationId: randomUUID(),
  name: "Same label",
  origin: "https://source.example",
  scope: ["read", "act"],
});
const directory = source.revise(sourceOwner, {
  mutationId: randomUUID(),
  expected: directoryDigest(first.document),
  members: [
    ...first.document.members,
    {
      ...destination.identity,
      origin,
      name: "Same label",
      grantId: randomUUID(),
    },
  ],
});
destination.approve(OWNER, {
  mutationId: randomUUID(),
  expected: null,
  kind: "enroll",
  scope: ["read", "act"],
  controller: source.identity,
  directory,
  grantId: directory.document.members[1].grantId,
});
function token(operation: "read" | "act") {
  const proof = sourceCredentials.prove(
    sourceOwner,
    credentials.challenge({
      fleetId: directory.document.fleetId,
      grantId: directory.document.members[1].grantId,
      destination: destination.identity.machineId,
      peer: source.identity.machineId,
      directory: directoryDigest(directory.document),
      operation,
    }),
  );
  return sourceCredentials.accept(sourceOwner, proof, credentials.issue(proof))
    .token;
}
const act = token("act"),
  read = token("read");
let hold: Promise<void> | undefined, began: (() => void) | undefined;
let loseReply = false;
const bridge = new FleetWorkspaceApp((req, res) => {
  if (loseReply) {
    const end = res.end;
    res.end = function (this: typeof res, ...args: Parameters<typeof res.end>) {
      // The real handler has already made its write when it ends the response.
      res.destroy();
      return end.apply(this, args);
    } as typeof res.end;
  }
  if (!hold) return app(req, res);
  began?.();
  void hold.then(() => app(req, res));
}, OWNER);
let actions = new FleetWorkspaceActions(
  db,
  destination,
  credentials,
  OWNER,
  bridge,
  secrets,
);
const pairing = new FleetPairing(
  db,
  destination,
  OWNER,
  process.env.LOOP_DATA_DIR,
);
const host = new Host(
  process.env.LOOP_DATA_DIR,
  {
    harness: "codex",
    version: "fixture",
    project: root,
    billing: { mode: "existing", description: "Isolated fixture" },
    capabilities: {
      approvals: true,
      questions: true,
      resume: true,
      liveAttach: false,
      terminal: false,
    },
  },
  pairing,
);
const enrollment = new FleetEnrollmentDestination(
  db,
  destination,
  pairing,
  OWNER,
  secrets,
  () => origin,
);
const peerHttp = () =>
  createFleetPeerHttp(enrollment, () => origin, {
    workspaceActions: actions,
    credentials,
  });
host.workspace = {
  http: app,
  peerHttp: peerHttp(),
  status: () => ({}),
  admin: async () => ({}),
  connect: () => () => {},
  originChanged: () => {},
};
const connectionId = randomUUID(),
  foreignOwner = randomUUID(),
  foreignAgent = randomUUID();
beforeAll(async () => {
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,'openai','Fixture','','connected',?,'{}',0)",
  ).run(connectionId, OWNER, JSON.stringify([{ id: "fixture" }]));
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,instructions,origin,created_at) VALUES(?,?,'Other owner','other-owner','openai','fixture','untouched','loop',0)",
  ).run(foreignAgent, foreignOwner);
  await host.listen();
  host.setOrigin(origin);
});
afterAll(async () => {
  actions.close();
  await host.close();
  await closeExecution();
  await nativeSessions.close();
  db.close();
  sourceDb.close();
  rmSync(root, { recursive: true, force: true });
});
function call(
  body: unknown,
  receipt = false,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: any; headers: object }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: host.port,
          path:
            "/api" +
            (receipt
              ? fleetWorkspaceActionApi.receipt.path
              : fleetWorkspaceActionApi.action.path),
          method: "POST",
          headers: {
            host: new URL(origin).host,
            "content-type": "application/json",
            "x-loop-fleet-version": "1",
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
              headers: res.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    },
  );
}
function command(
  route: string,
  body: unknown,
  params = {},
  commandId = randomUUID(),
) {
  return {
    version: 1,
    requestId: randomUUID(),
    commandId,
    credential: act,
    input: { route, params, body },
  };
}
function query(
  commandId: string,
  route: string,
  payloadDigest = "f".repeat(64),
) {
  return {
    version: 1,
    requestId: randomUUID(),
    commandId,
    credential: act,
    payloadDigest,
    route,
  };
}
let ownAgent: string;
let resumedRun: string;

it("creates and queues once through the real owning handlers and signs the original command receipt", async () => {
  const input = command("agentCreate", {
    name: "fleet-actions-fixture",
    connectionId,
    model: "fixture",
    initialPrompt: "Isolated queued work",
  });
  const first = await call(input);
  expect(first.status).toBe(200);
  const response = first.body.response;
  expect(response.receipt.state).toBe("completed");
  expect(response.receipt.commandId).toBe(input.commandId);
  expect(response.requestDigest).toBe(
    fleetPayloadDigest({
      requestId: input.requestId,
      commandId: input.commandId,
      input: input.input,
    }),
  );
  expect(
    verifyFleetProof(
      destination.identity,
      "workspace-action",
      response,
      first.body.signature,
    ),
  ).toBe(true);
  expect(
    verifyFleetProof(
      destination.identity,
      "workspace-action",
      { ...response, requestId: randomUUID() },
      first.body.signature,
    ),
  ).toBe(false);
  ownAgent = response.receipt.result.id;
  const runId = response.receipt.result.initialRun.id;
  const again = await call({ ...input, requestId: randomUUID() });
  expect(again.body.response.receipt).toEqual(response.receipt);
  expect(
    db.prepare("SELECT count(*) n FROM agents WHERE owner_id=?").get(OWNER),
  ).toEqual({ n: 1 });
  expect(
    db.prepare("SELECT count(*) n FROM runs WHERE agent_id=?").get(ownAgent),
  ).toEqual({ n: 1 });
  expect(
    db
      .prepare(
        "SELECT command_id FROM fleet_effect_authorizations WHERE effect_kind='run' AND effect_id=?",
      )
      .get(runId),
  ).toEqual({ command_id: input.commandId });
  const conflict = await call({
    ...input,
    input: {
      ...input.input,
      body: { ...(input.input.body as object), model: "different" },
    },
  });
  expect(conflict.status).toBe(409);
  expect(JSON.stringify(first)).not.toContain(act);
  expect(first.headers).not.toHaveProperty("set-cookie");
});

it("retains the resuming peer through the actual run action handler", async () => {
  const run = enqueue(OWNER, "Locally paused work", randomUUID());
  expect(transition(run, "paused")).toBe(true);
  const input = command("runAction", {}, { id: run.id, action: "resume" });
  const result = await call(input);
  expect(result.status).toBe(200);
  expect(result.body.response.receipt.state).toBe("completed");
  expect(ownedRun(run.id, OWNER).state).toBe("queued");
  expect(
    db
      .prepare(
        "SELECT command_id FROM fleet_effect_edit_authorizations WHERE owner_id=? AND effect_kind='run' AND effect_id=?",
      )
      .get(OWNER, run.id),
  ).toEqual({ command_id: input.commandId });
  resumedRun = run.id;
});

it("refuses wrong scope, foreign owners, replacement inner identities and undeclared operations", async () => {
  const input = command(
    "agentUpdate",
    { instructions: "Changed" },
    { id: ownAgent },
  );
  expect((await call({ ...input, credential: read })).status).toBe(403);
  expect((await call(input, false, { cookie: "fixture" })).status).toBe(403);
  expect((await call(input, false, { origin })).status).toBe(403);
  for (const route of [
    "connectionCreate",
    "runtimeProviderKey",
    "teamCreate",
    "native.setting",
    "agent-sources",
  ])
    expect(
      (await call({ ...input, input: { ...input.input, route } })).status,
    ).toBe(400);
  const mismatch = command(
    "nativeAnswer",
    { commandId: randomUUID(), answer: {} },
    { id: randomUUID() },
  );
  expect((await call(mismatch)).status).toBe(409);
  const foreign = await call(
    command("agentUpdate", { instructions: "Stolen" }, { id: foreignAgent }),
  );
  expect(foreign.body.response.receipt.state).toBe("refused");
  expect(
    db.prepare("SELECT instructions FROM agents WHERE id=?").get(foreignAgent),
  ).toEqual({ instructions: "untouched" });
  expect(JSON.stringify(foreign)).not.toContain(foreignOwner);
});

it("retains unknown writes after reply loss and replacement without invoking the handler again", async () => {
  const input = command(
    "agentUpdate",
    { instructions: "Accepted before lost reply" },
    { id: ownAgent },
  );
  loseReply = true;
  let failed: Awaited<ReturnType<typeof call>>;
  try {
    failed = await call(input);
  } finally {
    loseReply = false;
  }
  expect(failed!.body.response.receipt.state).toBe("unknown");
  expect(
    db.prepare("SELECT instructions FROM agents WHERE id=?").get(ownAgent),
  ).toEqual({ instructions: "Accepted before lost reply" });
  actions.close();
  actions = new FleetWorkspaceActions(
    db,
    destination,
    credentials,
    OWNER,
    bridge,
    secrets,
  );
  host.workspace!.peerHttp = peerHttp();
  db.prepare(
    "UPDATE agents SET instructions='Later local change' WHERE id=?",
  ).run(ownAgent);
  const receipt = await call(
    query(input.commandId, input.input.route, fleetPayloadDigest(input.input)),
    true,
  );
  expect(
    (await call(query(input.commandId, input.input.route), true)).status,
  ).toBe(409);
  expect(
    (
      await call(
        query(input.commandId, "agentCreate", fleetPayloadDigest(input.input)),
        true,
      )
    ).status,
  ).toBe(409);
  expect(receipt.body.response.receipt.state).toBe("unknown");
  expect(
    (await call({ ...input, requestId: randomUUID() })).body.response.receipt
      .state,
  ).toBe("unknown");
  expect(
    db.prepare("SELECT instructions FROM agents WHERE id=?").get(ownAgent),
  ).toEqual({ instructions: "Later local change" });
});

it("routes Done grouping through a durable command and rechecks the grant inside each write", async () => {
  const conversation = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Results',1)",
  ).run(conversation, OWNER, ownAgent);
  const cardIds = Array.from({ length: 2 }, () => {
    const run = randomUUID(),
      message = randomUUID();
    db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Task','completed',?,1,2)",
    ).run(run, OWNER, ownAgent, conversation, run);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','A completed result','{}',2)",
    ).run(message, OWNER, conversation, run);
    return `d:run:${run}`;
  });
  const group = randomUUID();
  const create = command(
    "doneThreadCreate",
    { id: group, title: "Combined results", cardIds },
    {},
    group,
  );
  const grouped = await call(create);
  expect(grouped.status).toBe(200);
  expect(grouped.body.response.receipt).toMatchObject({
    state: "completed",
    result: { id: group, cardIds: expect.arrayContaining(cardIds) },
  });
  expect((await call(create)).body.response.receipt).toEqual(
    grouped.body.response.receipt,
  );
  expect(
    (
      await call(
        command("doneThreadCreate", {
          id: randomUUID(),
          title: "Other",
          cardIds,
        }),
      )
    ).status,
  ).toBe(409);
  const { withFleetAction } =
    await import("../src/server/fleet-action-context.js");
  const {
    createDoneThread,
    moveDoneThreadCards,
    removeDoneThread,
    setDoneThreadRead,
  } = await import("../src/server/done-threads.js");
  const forbiddenGroup = randomUUID();
  const before = db
    .prepare(
      "SELECT * FROM done_thread_members WHERE thread_id=? ORDER BY card_id",
    )
    .all(group);
  for (const apply of [
    () =>
      createDoneThread(OWNER, {
        id: forbiddenGroup,
        title: "Forbidden",
        cardIds,
      }),
    () => moveDoneThreadCards(OWNER, group, cardIds),
    () => removeDoneThread(OWNER, group, cardIds[0]),
    () => removeDoneThread(OWNER, group),
    () => setDoneThreadRead(OWNER, group, true),
    () => setDoneThreadRead(OWNER, group, false),
  ]) {
    let checks = 0;
    expect(() =>
      withFleetAction(
        {
          owner: OWNER,
          commandId: randomUUID(),
          grant: credentials.authenticate(act).context,
        },
        () => {
          if (++checks > 1) throw new Error("grant changed before commit");
        },
        () => apply(),
      ),
    ).toThrow("grant changed before commit");
  }
  expect(
    db.prepare("SELECT 1 FROM done_threads WHERE id=?").get(forbiddenGroup),
  ).toBeUndefined();
  expect(
    db.prepare("SELECT 1 FROM done_threads WHERE id=?").get(group),
  ).toBeDefined();
  expect(
    db
      .prepare(
        "SELECT * FROM done_thread_members WHERE thread_id=? ORDER BY card_id",
      )
      .all(group),
  ).toEqual(before);
});

it("routes explicit mail resume through the original destination command and rechecks the grant", async () => {
  const conversation = randomUUID();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Results',1)",
  ).run(conversation, OWNER, ownAgent);
  const mailThread = randomUUID();
  db.prepare(
    "INSERT INTO agent_threads(id,owner_id,scope,subject,created_by,paused_at,created_at,updated_at) VALUES(?,?,'direct','Held mail',?,1,1,1)",
  ).run(mailThread, OWNER, ownAgent);
  db.prepare(
    "INSERT INTO agent_thread_members(thread_id,agent_id,conversation_id) VALUES(?,?,?)",
  ).run(mailThread, ownAgent, conversation);
  const resume = command(
    "agentMailResume",
    {},
    { id: ownAgent, threadId: mailThread },
  );
  expect((await call({ ...resume, credential: read })).status).toBe(403);
  expect(
    db
      .prepare("SELECT paused_at FROM agent_threads WHERE id=?")
      .get(mailThread),
  ).toEqual({ paused_at: 1 });
  const resumed = await call(resume);
  expect(resumed.status).toBe(200);
  expect(resumed.body.response.receipt).toMatchObject({
    state: "completed",
    result: { released: 0, refused: 0, held: 0 },
  });
  expect(
    db
      .prepare("SELECT paused_at FROM agent_threads WHERE id=?")
      .get(mailThread),
  ).toEqual({ paused_at: null });
  db.prepare("UPDATE agent_threads SET paused_at=2 WHERE id=?").run(mailThread);
  expect(
    (await call({ ...resume, requestId: randomUUID() })).body.response.receipt,
  ).toEqual(resumed.body.response.receipt);
  expect(
    db
      .prepare("SELECT paused_at FROM agent_threads WHERE id=?")
      .get(mailThread),
  ).toEqual({ paused_at: 2 });
  const foreign = await call(
    command("agentMailResume", {}, { id: foreignAgent, threadId: mailThread }),
  );
  expect(foreign.body.response.receipt.state).toBe("refused");

  const { withFleetAction } =
    await import("../src/server/fleet-action-context.js");
  const { resumeThread } = await import("../src/server/agent-mail.js");
  let checks = 0;
  expect(() =>
    withFleetAction(
      {
        owner: OWNER,
        commandId: randomUUID(),
        grant: credentials.authenticate(act).context,
      },
      () => {
        if (++checks > 1) throw new Error("grant changed before commit");
      },
      () => resumeThread(OWNER, null, mailThread),
    ),
  ).toThrow("grant changed before commit");
  expect(
    db
      .prepare("SELECT paused_at FROM agent_threads WHERE id=?")
      .get(mailThread),
  ).toEqual({ paused_at: 2 });
});

it("looks up a lost agent creation reply using the wire payload before defaults and idempotency binding", async () => {
  const input = command("agentCreate", {
    name: "fleet-lost-create-fixture",
    connectionId,
    model: "fixture",
    initialPrompt: "Create exactly one run despite reply loss",
  });
  loseReply = true;
  try {
    const lost = await call(input);
    expect(lost.body.response.receipt.state).toBe("unknown");
  } finally {
    loseReply = false;
  }
  const receipt = await call(
    query(input.commandId, "agentCreate", fleetPayloadDigest(input.input)),
    true,
  );
  expect(receipt.status).toBe(200);
  expect(receipt.body.response.receipt.state).toBe("unknown");
  expect(
    (await call({ ...input, requestId: randomUUID() })).body.response.receipt,
  ).toEqual(receipt.body.response.receipt);
  expect(
    db
      .prepare("SELECT count(*) n FROM agents WHERE owner_id=? AND name=?")
      .get(OWNER, "fleet-lost-create-fixture"),
  ).toEqual({ n: 1 });
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM runs r JOIN agents a ON a.id=r.agent_id AND a.owner_id=r.owner_id WHERE r.owner_id=? AND a.name=?",
      )
      .get(OWNER, "fleet-lost-create-fixture"),
  ).toEqual({ n: 1 });
});

it("replays a completed command while four unrelated handlers are pending", async () => {
  const completed = command(
    "agentUpdate",
    { instructions: "Cached result" },
    { id: ownAgent },
  );
  const first = await actions.action(completed);
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = Array.from({ length: 4 }, () =>
    actions.action(
      command(
        "agentUpdate",
        { instructions: "Later local change" },
        { id: ownAgent },
      ),
    ),
  );
  try {
    await setImmediate();
    const replay = await actions.action({
      ...completed,
      requestId: randomUUID(),
    });
    expect(replay.response.receipt).toEqual(first.response.receipt);
  } finally {
    release();
    hold = undefined;
    await Promise.all(waiting);
  }
});

it("counts one pending handler for concurrent duplicate commands", async () => {
  let release!: () => void,
    started = 0;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  began = () => {
    started++;
  };
  const first = command(
    "agentUpdate",
    { instructions: "Later local change" },
    { id: ownAgent },
  );
  const pending = [actions.action(first)];
  for (let index = 0; index < 3; index++)
    pending.push(actions.action({ ...first, requestId: randomUUID() }));
  for (let index = 0; index < 3; index++)
    pending.push(
      actions.action(
        command(
          "agentUpdate",
          { instructions: "Later local change" },
          { id: ownAgent },
        ),
      ),
    );
  const settled = Promise.allSettled(pending);
  try {
    await setImmediate();
    expect(started).toBe(4);
  } finally {
    release();
    hold = undefined;
    began = undefined;
    await settled;
  }
  for (const result of await settled) expect(result.status).toBe("fulfilled");
});

it("bounds actual action handlers and refuses a grant revoked while internal middleware is waiting", async () => {
  let release!: () => void,
    started = 0,
    allStarted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  began = () => {
    if (++started === 4) allStarted();
  };
  const inputs = Array.from({ length: 4 }, () =>
    command(
      "agentUpdate",
      { instructions: "Must not apply" },
      { id: ownAgent },
    ),
  );
  const requests = inputs.map((input) => call(input));
  try {
    await waiting;
    expect(
      (
        await call(
          command("agentUpdate", { instructions: "Fifth" }, { id: ownAgent }),
        )
      ).status,
    ).toBe(503);
    const removal = source.revise(sourceOwner, {
      mutationId: randomUUID(),
      expected: directoryDigest(directory.document),
      members: directory.document.members.filter(
        (member) => member.machineId !== destination.identity.machineId,
      ),
    });
    destination.accept(OWNER, removal);
    await expect(
      nativeSessions.execute(ownedRun(resumedRun, OWNER)),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    release();
    hold = undefined;
    began = undefined;
  }
  for (const result of await Promise.all(requests))
    expect(result.status).toBe(403);
  for (const input of inputs)
    expect(
      db
        .prepare(
          "SELECT state FROM fleet_command_receipts WHERE owner_id=? AND command_id=?",
        )
        .get(OWNER, input.commandId),
    ).toEqual({ state: "refused" });
  expect(
    db.prepare("SELECT instructions FROM agents WHERE id=?").get(ownAgent),
  ).toEqual({ instructions: "Later local change" });
  expect(
    (await call(query(inputs[0].commandId, inputs[0].input.route), true))
      .status,
  ).toBe(403);
});
