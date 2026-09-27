import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";

it("recovers native progress and final answers while preserving user-edited artifacts", () => {
  const db = new Database(":memory:");
  try {
    for (const file of readdirSync("migrations")
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort()) {
      if (file.startsWith("023")) break;
      db.exec(readFileSync("migrations/" + file, "utf8"));
    }
    for (const edited of [false, true]) {
      const id = edited ? "edited" : "untouched";
      db.prepare(
        "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,'owner','Test',0)",
      ).run(id);
      db.prepare(
        "INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,payload,result,created_at,updated_at) VALUES(?,'owner',?,'Test','completed',?,'{}','Progress\n\nFinal answer',0,0)",
      ).run(id, id, id);
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,'owner',?,?,'assistant','Progress\n\nFinal answer',0)",
      ).run(id, id, id);
      db.prepare(
        "INSERT INTO artifacts(id,owner_id,conversation_id,run_id,title,kind,content,version,created_at,updated_at) VALUES(?,'owner',?,?,'Test','markdown',?,?,0,0)",
      ).run(
        id,
        id,
        id,
        edited ? "My saved edits" : "Progress\n\nFinal answer",
        edited ? 2 : 1,
      );
      db.prepare(
        "INSERT INTO artifact_versions(id,artifact_id,version,content,created_at) VALUES(?,?,1,'Progress\n\nFinal answer',0)",
      ).run(id, id);
      if (edited)
        db.prepare(
          "INSERT INTO artifact_versions(id,artifact_id,version,content,created_at) VALUES('edit',?,2,'My saved edits',0)",
        ).run(id);
      db.prepare(
        "INSERT INTO agent_checkpoints(run_id,message_id,artifact_id,history,output,stage) VALUES(?,?,?,'[]','Progress\n\nFinal answer','done')",
      ).run(id, id, id);
      for (const [native, text, phase] of [
        ["progress", "Progress", "commentary"],
        ["final", "Final answer", "final_answer"],
        ["trailing", "Background cleanup", "commentary"],
      ]) {
        db.prepare("INSERT INTO native_items VALUES(?,?,?,?,0)").run(
          id,
          native,
          id,
          JSON.stringify({ id: native, kind: "assistant", text, phase }),
        );
      }
    }
    db.exec(readFileSync("migrations/023-native-progress.sql", "utf8"));
    expect(db.prepare("SELECT content FROM messages").all()).toEqual([
      { content: "Final answer" },
      { content: "Final answer" },
    ]);
    expect(
      db.prepare("SELECT content FROM artifacts ORDER BY id").all(),
    ).toEqual([{ content: "My saved edits" }, { content: "Final answer" }]);
    expect(
      db.prepare("SELECT content FROM artifact_versions WHERE version=2").get(),
    ).toEqual({ content: "My saved edits" });
    expect(
      db
        .prepare(
          "SELECT content FROM run_traces WHERE run_id='untouched' AND json_extract(metadata,'$.final')=0 ORDER BY id",
        )
        .all(),
    ).toEqual([{ content: "Progress" }, { content: "Background cleanup" }]);
    expect(
      db
        .prepare(
          "SELECT content FROM run_traces WHERE json_extract(metadata,'$.final')=1",
        )
        .all(),
    ).toEqual([{ content: "Final answer" }, { content: "Final answer" }]);
    expect(db.prepare("SELECT count(*) n FROM native_items").get()).toEqual({
      n: 6,
    });
  } finally {
    db.close();
  }
});
