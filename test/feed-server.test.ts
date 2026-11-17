import { seedAgent, seedMessage } from "./helpers/seed.js";
import { productionApp } from "./helpers/app.js";
import { testDirectory } from "./helpers/test-workspace.js";
import { afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";

testDirectory();

const { db, id, now } = await import("../src/server/db");
const { saveArtifact } = await import("../src/server/artifacts");
const { resultsRevision, resultsUpdates } =
  await import("../src/server/results");
const { core } = await import("../src/server/core-routes");
const { enqueue } = await import("../src/server/queue");
const app = await productionApp(undefined, [core], {
  ownerHeader: "x-owner",
  json: false,
});
const get = async (path: string, owner: string) => {
  const response = await fetch(`${app.url}/api${path}`, {
    headers: { "x-owner": owner },
  });
  return { status: response.status, ...(await response.json()) };
};
const cursor = (artifact: string) =>
  (
    db
      .prepare("SELECT rowid cursor FROM artifacts WHERE id=?")
      .get(artifact) as any
  ).cursor as number;
afterAll(async () => {
  await app.close();
  db.close();
});

it("returns only changed visible cards and removal tombstones, scoped to their owner", () => {
  const owner = "changes",
    keys = Array.from({ length: 100 }, (_, i) =>
      saveArtifact(owner, {
        title: String(i),
        content: "original",
        role: "answer",
      }),
    );
  const after = resultsRevision(owner),
    through = cursor(keys[20]);
  db.prepare(
    "UPDATE artifacts SET content='older edit',updated_at=1 WHERE id=?",
  ).run(keys[25]);
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(keys[30]);
  db.prepare("DELETE FROM artifacts WHERE id=?").run(keys[31]);
  db.prepare("UPDATE artifacts SET content='outside window' WHERE id=?").run(
    keys[5],
  );
  const newest = saveArtifact(owner, {
    title: "New",
    content: "new output",
    role: "snippet",
  });
  const stranger = saveArtifact("stranger", {
    title: "Private",
    content: "not for this owner",
    role: "answer",
  });
  const changes = resultsUpdates(owner, { after, through });
  expect(changes.items.map((i) => i.id)).toEqual([keys[25], newest]);
  expect(changes.items[0].content).toBe("older edit");
  expect(changes.removed).toEqual([keys[30], keys[31]]);
  expect(changes.more).toBe(false);
  expect(
    resultsUpdates("stranger", { after: 0, through: 0 }).items.map((i) => i.id),
  ).toEqual([stranger]);
  expect(
    resultsUpdates(owner, { after: changes.revision, through }).items,
  ).toEqual([]);
});

it("bounds batches at 200 and never skips repeated edits while a backlog is drained", () => {
  const owner = "backlog",
    keys = Array.from({ length: 450 }, () =>
      saveArtifact(owner, {
        title: "Card",
        content: "original",
        role: "answer",
      }),
    );
  const first = resultsUpdates(owner, { after: 0, through: 0 });
  expect(first.items).toHaveLength(200);
  expect(first.more).toBe(true);
  for (const content of ["second", "third", "latest"])
    db.prepare("UPDATE artifacts SET content=?,updated_at=0 WHERE id=?").run(
      content,
      keys[0],
    );
  const second = resultsUpdates(owner, { after: first.revision, through: 0 });
  const third = resultsUpdates(owner, { after: second.revision, through: 0 });
  expect(second.items).toHaveLength(200);
  expect(third.items).toHaveLength(51);
  expect(third.more).toBe(false);
  const merged = new Map(
    [...first.items, ...second.items, ...third.items].map((i) => [i.id, i]),
  );
  expect(merged.size).toBe(450);
  expect(merged.get(keys[0]).content).toBe("latest");
  expect(
    db
      .prepare("SELECT count(*) n FROM feed_revisions WHERE object_id=?")
      .get(keys[0]),
  ).toEqual({ n: 1 });
});

it("reconciles file filters and agent labels and includes prompt changes", () => {
  const owner = "filters",
    agent = id();
  seedAgent(db, {
    id: agent,
    owner_id: owner,
    name: "Before",
    normalized_name: agent,
    provider: "openai",
    model: "fixture",
    created_at: now(),
  });
  const artifact = saveArtifact(owner, {
    title: "Chart",
    kind: "chart",
    content: "data",
    agent,
    role: "answer",
  });
  const conversation = id(),
    message = id();
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Chat',?)",
  ).run(conversation, owner, agent, now());
  seedMessage(db, {
    id: message,
    owner_id: owner,
    conversation_id: conversation,
    role: "user",
    content: "Question",
    created_at: now(),
  });
  const after = resultsRevision(owner);
  db.prepare("UPDATE agents SET name='After' WHERE id=?").run(agent);
  expect(
    resultsUpdates(owner, { after, through: 0, agent, view: "files" }).items[0]
      .name,
  ).toBe("After");
  expect(
    resultsUpdates(owner, { after, through: 0, agent, view: "prompts" })
      .items[0],
  ).toMatchObject({ id: message, name: "After", content: "Question" });
  db.prepare("UPDATE artifacts SET kind='markdown' WHERE id=?").run(artifact);
  expect(
    resultsUpdates(owner, { after, through: 0, view: "files" }).removed,
  ).toEqual([artifact]);
  expect(
    resultsUpdates(owner, { after, through: 0, agent: "other" }).removed,
  ).toEqual([artifact]);
  db.prepare("DELETE FROM messages WHERE id=?").run(message);
  expect(
    resultsUpdates(owner, { after, through: 0, view: "prompts" }).removed,
  ).toEqual([message]);
});

it("keeps project feed updates scoped when outputs are filed or moved", () => {
  const owner = "project-feed",
    project = id(),
    other = id();
  for (const folder of [project, other])
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project',?,?)",
    ).run(folder, owner, folder, now());
  const filed = saveArtifact(owner, {
    title: "Filed",
    content: "A",
    folder: project,
    role: "answer",
  });
  const elsewhere = saveArtifact(owner, {
    title: "Elsewhere",
    content: "B",
    folder: other,
    role: "answer",
  });
  const first = resultsUpdates(owner, {
    after: 0,
    through: 0,
    folder: project,
  });
  expect(first.items.map((item) => item.id)).toEqual([filed]);
  expect(first.removed).toContain(elsewhere);
  db.prepare("UPDATE artifacts SET folder_id=?,updated_at=? WHERE id=?").run(
    other,
    now(),
    filed,
  );
  expect(
    resultsUpdates(owner, {
      after: first.revision,
      through: 0,
      folder: project,
    }).removed,
  ).toContain(filed);
});

it("includes nested project folders and excludes another owner's folder tree", async () => {
  const { projectFolders } = await import("../src/server/results");
  const owner = "nested-project-feed",
    project = id(),
    child = id(),
    foreign = id();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Parent',?)",
  ).run(project, owner, now());
  for (const [folder, who] of [
    [child, owner],
    [foreign, "other-owner"],
  ])
    db.prepare(
      "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES(?,?,?,'folder','Child',?)",
    ).run(folder, who, project, now());
  const artifact = saveArtifact(owner, {
    title: "Nested result",
    content: "Finished",
    folder: child,
    role: "answer",
  });
  expect(projectFolders(owner, project)).toEqual([project, child]);
  expect(
    resultsUpdates(owner, { after: 0, through: 0, folder: project }).items.map(
      (item) => item.id,
    ),
  ).toContain(artifact);
  expect(projectFolders("other-owner", project)).toEqual([]);
  const outside = saveArtifact(owner, {
    title: "Elsewhere",
    content: "Other project",
    role: "answer",
  });
  const privateArtifact = saveArtifact("other-owner", {
    title: "Private",
    content: "Other owner",
    folder: foreign,
    role: "answer",
  });
  expect(
    (await get(`/results?folder=${project}`, owner)).items.map(
      (item: any) => item.id,
    ),
  ).toEqual([artifact]);
  expect((await get(`/results?folder=${project}`, "other-owner")).status).toBe(
    404,
  );
  expect((await get(`/results?folder=${foreign}`, owner)).status).toBe(404);
  const conversation = id(),
    agent = id();
  seedAgent(db, {
    id: agent,
    owner_id: owner,
    name: agent,
    normalized_name: agent,
    provider: "openai",
    model: "fixture",
    created_at: now(),
  });
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Project chat',?)",
  ).run(conversation, owner, agent, now());
  const prompts = [child, project, null].map((folderId) => {
    const run = enqueue(owner, "Question", id(), {
      agent,
      conversation,
      payload: { folderId },
    });
    const message = id();
    seedMessage(db, {
      id: message,
      owner_id: owner,
      conversation_id: conversation,
      run_id: run.id,
      role: "user",
      content: "Question",
      created_at: now(),
    });
    return message;
  });
  expect(
    (await get(`/results?view=prompts&folder=${project}`, owner)).items.map(
      (item: any) => item.id,
    ),
  ).toEqual([prompts[1], prompts[0]]);
  expect(
    (await get(`/results?folder=${project}`, owner)).items.map(
      (item: any) => item.id,
    ),
  ).not.toEqual(expect.arrayContaining([outside, privateArtifact]));
});

function nativeAnswer(
  owner: string,
  content: string,
  state: string,
  partial = false,
) {
  const agent = id(),
    conversation = id(),
    message = id();
  seedAgent(db, {
    id: agent,
    owner_id: owner,
    name: agent,
    normalized_name: agent,
    provider: "pi",
    model: "fixture",
    created_at: now(),
  });
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Native conversation',?)",
  ).run(conversation, owner, agent, now());
  const run = enqueue(owner, "Native question", id(), { agent, conversation });
  seedMessage(db, {
    id: message,
    owner_id: owner,
    conversation_id: conversation,
    run_id: run.id,
    role: "assistant",
    content: content,
    created_at: now(),
  });
  const artifact = saveArtifact(owner, {
    agent,
    conversation,
    run: run.id,
    title: "Native answer",
    content,
    metadata: { native: true },
    role: "answer",
  });
  db.prepare(
    "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history,stage) VALUES(?,?,?,'[]',?)",
  ).run(run.id, message, artifact, partial ? "native" : "done");
  db.prepare("UPDATE runs SET state=? WHERE id=?").run(state, run.id);
  return { agent, conversation, run: run.id, artifact };
}

it("publishes native answers to feed and profile updates without exposing tools, partials or another owner", async () => {
  const owner = "native-feed",
    subscription = id();
  db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?)").run(
    subscription,
    owner,
    "https://fcm.googleapis.com/native-feed",
    "fixture",
    now(),
  );
  const answer = nativeAnswer(owner, "", "running", true);
  const tool = saveArtifact(owner, {
    agent: answer.agent,
    conversation: answer.conversation,
    run: answer.run,
    title: "Native tool",
    content: "private tool output",
    metadata: { native: true },
    role: "answer",
  });
  const after = resultsRevision(owner);
  expect((await get("/results", owner)).items).toEqual([]);
  expect(
    db
      .prepare("SELECT 1 FROM push_deliveries WHERE subscription_id=?")
      .get(subscription),
  ).toBeUndefined();
  db.prepare(
    "UPDATE artifacts SET content='Final native answer',metadata=? WHERE id=?",
  ).run(JSON.stringify({ native: true }), answer.artifact);
  db.prepare("UPDATE agent_checkpoints SET stage='done' WHERE run_id=?").run(
    answer.run,
  );
  db.prepare("UPDATE runs SET state='completed' WHERE id=?").run(answer.run);
  nativeAnswer(owner, "Not finished", "completed", true);
  nativeAnswer(owner, "Failed answer", "failed");
  nativeAnswer(owner, "Interrupted answer", "interrupted");
  nativeAnswer(owner, "   ", "completed");
  nativeAnswer("native-stranger", "Another owner's answer", "completed");
  for (const filter of ["", `&agent=${answer.agent}`]) {
    expect(
      (await get(`/results?${filter}`, owner)).items.map(
        (item: any) => item.id,
      ),
    ).toEqual([answer.artifact]);
    const updates = await get(
      `/results/updates?after=${after}&through=0${filter}`,
      owner,
    );
    expect(updates.items.map((item: any) => item.id)).toEqual([
      answer.artifact,
    ]);
    expect(updates.removed).toContain(tool);
  }
  expect(
    (await get(`/results?agent=${answer.agent}`, "native-stranger")).status,
  ).toBe(404);
  expect(
    db
      .prepare(
        "SELECT artifact_id FROM push_deliveries WHERE subscription_id=?",
      )
      .all(subscription),
  ).toEqual([{ artifact_id: answer.artifact }]);
});

it("restores previously published native cards without rewriting answers or replaying notifications", async () => {
  const owner = "native-history";
  const answer = nativeAnswer(owner, "Existing final answer", "completed");
  const subscription = id();
  db.prepare("INSERT INTO push_subscriptions VALUES(?,?,?,?,?)").run(
    subscription,
    owner,
    "https://fcm.googleapis.com/native-history",
    "fixture",
    now(),
  );
  const after = resultsRevision(owner);
  db.prepare("DELETE FROM schema_version WHERE version=33").run();
  db.exec(
    readFileSync(
      new URL(
        "../migrations/033-native-answer-publication.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const updates = await get(`/results/updates?after=${after}&through=0`, owner);
  expect(updates.items).toMatchObject([
    { id: answer.artifact, content: "Existing final answer" },
  ]);
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM artifact_publications WHERE artifact_id=?",
      )
      .get(answer.artifact),
  ).toEqual({ n: 1 });
  expect(
    db
      .prepare(
        "SELECT version,content FROM artifact_versions WHERE artifact_id=?",
      )
      .all(answer.artifact),
  ).toEqual([{ version: 1, content: "Existing final answer" }]);
  expect(
    db
      .prepare("SELECT 1 FROM push_deliveries WHERE subscription_id=?")
      .get(subscription),
  ).toBeUndefined();
});
