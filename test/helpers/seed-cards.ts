import type { cardsFixture } from "./cards-fixture";
export async function seedCards(
  fixture: Awaited<ReturnType<typeof cardsFixture>>,
  count = 46,
) {
  const { db, owner, origin, browser } = fixture;
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('writer',?,'Writer','writer','openai','fixture',1)",
  ).run(owner);
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('project',?,'project','Card project',1),('other',?,'project','Other project',1)",
  ).run(owner, owner);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES('thread',?,'writer','Card conversation','project',1)",
  ).run(owner);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('run',?,'writer','thread','Prompt','completed','seed',1,1)",
  ).run(owner);
  const result = db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,folder_id,title,kind,role,content,metadata,pinned,created_at,updated_at) VALUES(?,?,'writer','thread','run','project',?,'markdown','answer',?,'{}',1,?,?)",
  );
  const message = db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,'thread','run','user',?,'{\"personal\":true}',?)",
  );
  db.transaction(() => {
    for (let n = 0; n < count; n++) {
      const id = String(n).padStart(3, "0"),
        at = 1700000000000 + n;
      result.run(
        "result-" + id,
        owner,
        "Answer " + id,
        "# Complete answer " +
          id +
          "\n\nSelectable [reference](https://example.com/).\n\n" +
          "Long paragraph for reading. ".repeat(300) +
          "\n\nEnd of answer " +
          id,
        at,
        at,
      );
      message.run("message-" + id, owner, "Personal prompt " + id, at);
      db.prepare(
        "INSERT INTO message_bookmarks(message_id,owner_id,created_at) VALUES(?,?,?)",
      ).run("message-" + id, owner, at);
      db.prepare(
        "UPDATE artifact_bookmarks SET saved_at=? WHERE artifact_id=?",
      ).run(at, "result-" + id);
    }
  }).immediate();
  const uploads = [];
  for (const [name, content] of [
    ["notes.txt", "Fixture attachment contents"],
    ["details.txt", "Second fixture attachment"],
  ]) {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/plain" }), name);
    const response = await fetch(origin + "/api/uploads", {
      method: "POST",
      headers: browser,
      body: form,
    });
    if (!response.ok)
      throw new Error("Could not seed card upload: " + (await response.text()));
    uploads.push(await response.json());
  }
  const file = uploads[0];
  db.prepare("UPDATE artifacts SET pinned=1 WHERE id=?").run(file.id);
  db.prepare("UPDATE messages SET metadata=? WHERE id=?").run(
    JSON.stringify({ personal: true, attachments: uploads }),
    "message-" + String(count - 1).padStart(3, "0"),
  );
  return { file, count };
}
