import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";
import express from "express";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { createAgent, ownedRun } = await import("../src/server/domain");
const { seal } = await import("../src/server/secrets");
const { submit } = await import("../src/server/agent-runtime");
const { invokeNative, nativeBindings } =
  await import("../src/server/native-tools");
const { core } = await import("../src/server/core-routes");
const { resultCardAttachments } =
  await import("../src/server/card-attachments");
const { forkConversation } = await import("../src/server/mobile-return");
const { continueConversation } =
  await import("../src/server/conversation-continuations");
const {
  getResult,
  listConversationResults,
  publishCompletedRunResult,
  publishImportedConversationResults,
} = await import("../src/server/result-publication");

const app = express();
app.use(express.json(), (req, res, next) => {
  res.locals.owner = req.get("x-owner");
  next();
});
app.use(core);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.status || 400).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
async function get(owner: string, path: string) {
  const response = await fetch(base + path, { headers: { "x-owner": owner } });
  return { status: response.status, body: await response.json() };
}
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

function fixture(owner = id()) {
  const connection = id();
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES(?,?,'openai','Fixture',?,'connected',?,?)",
  ).run(
    connection,
    owner,
    seal("fixture", owner),
    JSON.stringify([{ id: "fixture" }]),
    now(),
  );
  const agent = createAgent(owner, {
    name: "reader-" + id().slice(0, 8),
    connectionId: connection,
    model: "fixture",
  });
  const queued = submit(owner, {
    agentId: agent.id,
    input: "Investigate the long task",
    idempotencyKey: id(),
  });
  db.prepare(
    "UPDATE runs SET state='running',worker_id='fixture' WHERE id=?",
  ).run(queued.id);
  return { owner, agent, run: ownedRun(queued.id, owner) };
}
function steer(f: ReturnType<typeof fixture>) {
  submit(f.owner, {
    agentId: f.agent.id,
    conversationId: f.run.conversation_id!,
    input: "What have you found?",
    idempotencyKey: id(),
    steer: true,
  });
  return db
    .prepare(
      "SELECT id,message_id FROM run_steering WHERE run_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(f.run.id) as { id: string; message_id: string };
}
async function reply(f: ReturnType<typeof fixture>, replyTo: string) {
  db.prepare("UPDATE run_steering SET state='sending' WHERE message_id=?").run(
    replyTo,
  );
  const binding = nativeBindings(f.run).find(
    (tool) => tool.tool === "loop_reply",
  )!;
  const result = await invokeNative(f.run, binding, id(), {
    replyTo,
    body: "Sealed reply body.",
  });
  if (!("result" in result)) throw new Error("Replies publish immediately");
  return JSON.parse(result.result.content[0].text) as { messageId: string };
}
function complete(f: ReturnType<typeof fixture>, text = "Final answer.") {
  const message = id();
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,'{}',?)",
  ).run(message, f.owner, f.run.conversation_id, f.run.id, text, now() + 5);
  db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(
    now() + 10,
    f.run.id,
  );
  return message;
}

it("opens a published reply from its sealed content after the transcript changes", async () => {
  const f = fixture();
  const question = steer(f);
  const published = await reply(f, question.message_id);
  db.prepare("UPDATE messages SET content='Edited later' WHERE id=?").run(
    published.messageId,
  );
  const opened = await get(f.owner, `/messages/${published.messageId}`);
  expect(opened.status).toBe(200);
  expect(opened.body.content).toBe("Sealed reply body.");
  // Another owner cannot read it through the canonical overlay either.
  const foreign = await get(id(), `/messages/${published.messageId}`);
  expect(foreign.status).toBeGreaterThanOrEqual(400);
});

it("records the execution provider and placement, not the agent's later settings", async () => {
  const f = fixture();
  const folder = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Origin project',?)",
  ).run(folder, f.owner, now());
  db.prepare(
    "UPDATE runs SET payload=json_set(payload,'$.folderId',?) WHERE id=?",
  ).run(folder, f.run.id);
  db.prepare("UPDATE conversations SET team_id=NULL WHERE id=?").run(
    f.run.conversation_id,
  );
  db.prepare("UPDATE agents SET provider='anthropic' WHERE id=?").run(
    f.agent.id,
  );
  complete(f);
  const result = publishCompletedRunResult(f.run.id, f.owner, db)!;
  expect(result.provenance.provider).toBe("openai");
  expect(result.provenance.placement).toEqual({
    status: "recorded",
    folderId: folder,
    projectId: folder,
    projectName: "Origin project",
    teamId: null,
  });
  // Later reorganization does not change the sealed placement.
  db.prepare("UPDATE folders SET name='Renamed' WHERE id=?").run(folder);
  expect(
    getResult(f.owner, result.id, db)!.provenance.placement.projectName,
  ).toBe("Origin project");
});

it("chains results chronologically across kinds and joins imported history", async () => {
  const f = fixture();
  const question = steer(f);
  const published = await reply(f, question.message_id);
  complete(f);
  const run = publishCompletedRunResult(f.run.id, f.owner, db)!;
  const replyResult = getResult(f.owner, `reply:${published.messageId}`, db)!;
  expect(replyResult.lineage.parentResultId).toBeNull();
  expect(run.lineage.parentResultId).toBe(replyResult.id);

  // A retry of the sealed publication keeps the same predecessor.
  expect(publishCompletedRunResult(f.run.id, f.owner, db)!.lineage).toEqual(
    run.lineage,
  );

  const conversation = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,created_at) VALUES(?,?,?,'Imported','openai-import',1)",
  ).run(conversation, f.owner, f.agent.id);
  for (const [n, role] of [
    [1, "user"],
    [2, "assistant"],
    [3, "assistant"],
  ] as const) {
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,NULL,?,?,'{}',?)",
    ).run(
      `imp-${conversation}-${n}`,
      f.owner,
      conversation,
      role,
      `text ${n}`,
      n,
    );
  }
  const imported = publishImportedConversationResults(
    f.owner,
    conversation,
    db,
  );
  expect(imported[0].lineage.parentResultId).toBeNull();
  expect(imported[1].lineage.parentResultId).toBe(imported[0].id);

  // Continuing the imported conversation does not start another root.
  const next = submit(f.owner, {
    agentId: f.agent.id,
    conversationId: conversation,
    input: "Continue",
    idempotencyKey: id(),
  });
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant','Continued',?,?,?)".replace(
      ",?,?,?)",
      ",'{}',?)",
    ),
  ).run(id(), f.owner, conversation, next.id, now() + 100);
  db.prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?").run(
    now() + 101,
    next.id,
  );
  const continued = publishCompletedRunResult(next.id, f.owner, db)!;
  expect(continued.lineage.parentResultId).toBe(imported[1].id);
});

it("publishes sealed Results for forked and continued conversations", () => {
  const f = fixture();
  const source = f.run.conversation_id!;
  complete(f, "Answer worth copying");
  const answer = db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='assistant'",
    )
    .get(source) as { id: string };
  const fork = forkConversation(f.owner, source, {
    messageId: answer.id,
    agentId: f.agent.id,
  });
  const forked = listConversationResults(f.owner, fork.id, db);
  expect(forked.map((r) => r.kind)).toEqual(["imported_answer"]);
  expect(forked[0].outcome.body).toBe("Answer worth copying");

  const continuation = continueConversation(f.owner, source, {
    agentId: f.agent.id,
    messageIds: [answer.id],
    start: { input: "Go on", idempotencyKey: id() },
  } as any);
  const continued = listConversationResults(f.owner, continuation.id, db);
  expect(continued.map((r) => r.kind)).toEqual(["imported_answer"]);
  // The copy is sealed: later edits to the copied message do not change it.
  db.prepare(
    "UPDATE messages SET content='mutated' WHERE conversation_id=? AND role='assistant'",
  ).run(continuation.id);
  expect(getResult(f.owner, continued[0].id, db)!.outcome.body).toBe(
    "Answer worth copying",
  );
});

it("links attachments to the sealed version while keeping current authorization", () => {
  const owner = id();
  const other = id();
  for (const [oid, own] of [
    ["obj-sealed", owner],
    ["obj-new", owner],
    ["obj-foreign", other],
  ]) {
    db.prepare(
      "INSERT INTO objects(id,owner_id,name,mime,bytes,created_at) VALUES(?,?,'f.md','text/markdown',x'41',1)",
    ).run(oid + owner, own);
  }
  const artifact = id();
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,title,kind,role,content,metadata,version,created_at,updated_at) VALUES(?,?,'Doc','file','upload','a',?,2,1,1)",
  ).run(artifact, owner, JSON.stringify({ objectId: "obj-new" + owner }));
  const ref = (extra: object) =>
    JSON.stringify([
      {
        artifactId: artifact,
        objectId: "obj-sealed" + owner,
        version: 1,
        sha256: null,
        name: "f.md",
        mime: "text/markdown",
        size: 1,
        published: false,
        ...extra,
      },
    ]);
  // The artifact now points at a newer object; the Result keeps the sealed one.
  expect(resultCardAttachments(owner, ref({}))![0].download).toBe(
    "/api/objects/obj-sealed" + owner,
  );
  // Authorization is still the owner's current access.
  expect(resultCardAttachments(other, ref({}))).toEqual([]);
  expect(resultCardAttachments(owner, ref({}))![0]).toMatchObject({
    name: "f.md",
    availability: "sealed",
    // Opening the current artifact stays a separate action.
    href: `/?artifact=${artifact}`,
  });
  // Renaming the artifact keeps the published name.
  db.prepare("UPDATE artifacts SET title='Renamed' WHERE id=?").run(artifact);
  expect(resultCardAttachments(owner, ref({}))![0].name).toBe("f.md");
  // A sealed object that is gone is reported unavailable rather than linked
  // to the current file.
  expect(
    resultCardAttachments(owner, ref({ objectId: "missing" }))![0],
  ).toMatchObject({ download: null, availability: "unavailable" });
  // Another owner's existing object never resolves.
  expect(
    db
      .prepare("SELECT owner_id FROM objects WHERE id=?")
      .get("obj-foreign" + owner),
  ).toEqual({ owner_id: other });
  expect(
    resultCardAttachments(owner, ref({ objectId: "obj-foreign" + owner }))![0],
  ).toMatchObject({ download: null, availability: "unavailable" });
  // A published file only links while its bytes still match the sealed digest.
  db.prepare(
    "INSERT INTO artifact_objects(artifact_id,owner_id,run_id,call_id,object_key,mime,size,checksum) VALUES(?,?,'r','c','k','text/markdown',1,'aa')",
  ).run(artifact, owner);
  expect(
    resultCardAttachments(
      owner,
      ref({ objectId: null, published: true, sha256: "aa" }),
    )![0].download,
  ).toBe(`/api/artifacts/${artifact}/file`);
  expect(
    resultCardAttachments(
      owner,
      ref({ objectId: null, published: true, sha256: "bb" }),
    )![0].download,
  ).toBeNull();
  // A legacy reference without a recorded checksum proves nothing about the
  // current bytes.
  expect(
    resultCardAttachments(
      owner,
      ref({ objectId: null, published: true, sha256: null }),
    )![0],
  ).toMatchObject({ download: null, availability: "unavailable" });
});
