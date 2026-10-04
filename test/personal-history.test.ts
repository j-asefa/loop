import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "loop-personal-history-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_ENCRYPTION_KEY = randomBytes(32).toString("hex");
const { db } = await import("../src/server/db");
const { personalHistory } = await import("../src/server/personal-history");
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
for (const owner of ["alice", "bob"]) {
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(owner, owner, owner, owner, "openai", "test", 1);
  for (const project of ["one", "two"]) {
    const key = owner + project;
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project',?,1)",
    ).run(key, owner, project);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,?,?,1)",
    ).run(key, owner, owner, key, key);
  }
}
function message(
  id: string,
  {
    owner = "alice",
    project = "one",
    metadata = { personal: true, attachments: [] },
    time = 100,
    role = "user",
  }: {
    owner?: string;
    project?: string;
    metadata?: object;
    time?: number;
    role?: string;
  } = {},
) {
  const conversation = owner + project;
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'prompt','completed',?,?,?)",
  ).run(id, owner, owner, conversation, id, time, time);
  db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    id,
    owner,
    conversation,
    id,
    role,
    "Prompt " + id,
    JSON.stringify(metadata),
    time,
  );
}
it("returns personal prompts across projects and maps the run recipient", () => {
  message("first");
  message("second", { project: "two" });
  message("other", { owner: "bob" });
  message("automated", { metadata: { personal: false, attachments: [] } });
  message("workflow", { metadata: {} });
  message("answer", { role: "assistant" });
  message("native", { metadata: { backend: "hapi", attachments: [] } });
  message("legacy", { metadata: { attachments: [] } });
  message("delegated", { metadata: { attachments: [] } });
  db.prepare(
    "INSERT INTO delegations(parent_run_id,call_id,child_run_id,arguments) VALUES('first','call','delegated','{}')",
  ).run();
  db.prepare(
    "UPDATE conversations SET agent_id='bob' WHERE id='aliceone'",
  ).run();
  const items = personalHistory("alice").items;
  expect(items.map((i) => i.id).sort()).toEqual(["first", "legacy", "second"]);
  expect(items.find((i) => i.id === "first")?.agent_name).toBe("alice");
  expect(new Set(items.map((i) => i.project_name))).toEqual(
    new Set(["one", "two"]),
  );
  expect(personalHistory("bob").items.map((i) => i.id)).toEqual(["other"]);
  db.prepare(
    "UPDATE conversations SET agent_id='alice' WHERE id='aliceone'",
  ).run();
});
it("labels prompts from nested folders with their root project", () => {
  db.prepare(
    "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES('alicechild','alice','aliceone','folder','Child',1),('alicegrandchild','alice','alicechild','folder','Grandchild',1)",
  ).run();
  message("nested-folder", { time: 150 });
  db.prepare("UPDATE runs SET payload=? WHERE id='nested-folder'").run(
    JSON.stringify({ folderId: "alicegrandchild" }),
  );
  expect(
    personalHistory("alice").items.find((item) => item.id === "nested-folder")
      ?.project_name,
  ).toBe("one");
});
it("paginates equal timestamps while newer messages arrive and rejects malformed cursors", () => {
  for (let i = 0; i < 62; i++)
    message("page-" + String(i).padStart(3, "0"), { time: 200 });
  const first = personalHistory("alice");
  expect(first.items).toHaveLength(50);
  expect(first.next).toBeTruthy();
  message("new-arrival", { time: 300 });
  const second = personalHistory("alice", first.next!);
  const ids = [...first.items, ...second.items].map((i) => i.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => id.startsWith("page-"))).toHaveLength(62);
  expect(ids).not.toContain("new-arrival");
  expect(() => personalHistory("alice", "not-a-cursor")).toThrow(
    "Invalid prompt cursor",
  );
});
it("preserves attachment-only content, follows agent renames, and labels missing recipients", () => {
  message("attachment-only", {
    metadata: {
      personal: true,
      attachments: [{ id: "file", name: "notes.txt" }],
    },
  });
  db.prepare("UPDATE messages SET content='' WHERE id='attachment-only'").run();
  db.prepare("UPDATE agents SET name='Renamed agent' WHERE id='alice'").run();
  const item = personalHistory("alice").items.find(
    (i) => i.id === "attachment-only",
  );
  // Reach older entries through pagination.
  const first = personalHistory("alice");
  const older = personalHistory("alice", first.next!).items.find(
    (i) => i.id === "attachment-only",
  )!;
  expect(item || older).toMatchObject({
    content: "",
    agent_name: "Renamed agent",
    attachments: [{ id: "file", name: "notes.txt" }],
  });
  db.prepare("UPDATE runs SET agent_id=NULL WHERE id='attachment-only'").run();
  expect(
    personalHistory("alice", first.next!).items.find(
      (i) => i.id === "attachment-only",
    )!.agent_name,
  ).toBeNull();
});
it("rechecks conversation and project ownership on subsequent reads", () => {
  const first = personalHistory("alice");
  db.prepare(
    "UPDATE conversations SET owner_id='bob' WHERE id='aliceone'",
  ).run();
  expect(personalHistory("alice", first.next!).items.map((i) => i.id)).toEqual([
    "second",
  ]);
  db.prepare("UPDATE folders SET owner_id='bob' WHERE id='alicetwo'").run();
  expect(personalHistory("alice").items).toEqual([]);
});
