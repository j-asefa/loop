import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Quote layout cases need an older reply target: the latest answer in an idle
// thread is intentionally unquoted. Keep the original result and its message.
export async function seedNewerReplyMessage(fixture) {
  const original = fixture.db
    .prepare("SELECT conversation_id,run_id,metadata FROM artifacts WHERE id=?")
    .get(fixture.artifacts[0]);
  const messageId = randomUUID();
  const content = "Newer message for the quoted-reply layout fixture.";
  fixture.db
    .prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant',?,?)",
    )
    .run(
      messageId,
      fixture.owner,
      original.conversation_id,
      original.run_id,
      content,
      Date.now(),
    );
  const thread = await fixture.api(
    "/conversations/" + original.conversation_id,
  );
  assert.equal(thread.latest_agent_message.id, messageId);
  assert.notEqual(messageId, JSON.parse(original.metadata).messageId);
  return { messageId, content };
}
