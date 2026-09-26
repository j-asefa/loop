import { db } from "./db.js";
import { owned } from "./domain.js";

export function agentMessages(owner: string, agent: string) {
  owned("agents", agent, owner);
  const updates = db.prepare(`SELECT 'trace:'||t.id id,t.content,t.created_at,
    r.conversation_id,r.id run_id,0 final FROM run_traces t
    JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
    WHERE t.owner_id=? AND r.agent_id=? AND t.kind='message'
    AND json_extract(t.metadata,'$.final') IS NOT 1 AND length(trim(t.content))>0
    ORDER BY t.id DESC LIMIT 200`).all(owner, agent) as any[];
  const finals = db.prepare(`SELECT m.id,m.content,m.created_at,m.conversation_id,
    m.run_id,1 final FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE m.owner_id=? AND c.agent_id=? AND m.role='assistant'
    AND length(trim(m.content))>0 ORDER BY m.rowid DESC LIMIT 200`)
    .all(owner, agent) as any[];
  const native = db.prepare(`SELECT n.native_id,n.item,n.updated_at,n.run_id,r.conversation_id
    FROM native_items n JOIN runs r ON r.id=n.run_id AND r.owner_id=?
    WHERE r.agent_id=? ORDER BY n.updated_at DESC LIMIT 200`).all(owner, agent) as any[];
  const nativeMessages = native.flatMap((row) => {
    const item = JSON.parse(row.item);
    return item.kind === "assistant" && item.text?.trim()
      ? [{ id: `native:${row.native_id}`, content: item.text,
           created_at: row.updated_at, conversation_id: row.conversation_id,
           run_id: row.run_id, final: false }] : [];
  });
  return [...updates, ...finals, ...nativeMessages]
    .sort((a, b) => b.created_at - a.created_at).slice(0, 200);
}

export function conversationUpdates(owner: string, conversation: string, run: string) {
  const traces = db.prepare(`SELECT 'trace:'||t.id id,t.content,t.created_at,
    r.conversation_id,r.id run_id,'assistant' role,t.metadata
    FROM run_traces t JOIN runs r ON r.id=t.run_id AND r.owner_id=t.owner_id
    WHERE t.owner_id=? AND r.conversation_id=? AND r.id=?
    AND t.kind='message' AND json_extract(t.metadata,'$.final') IS NOT 1
    AND length(trim(t.content))>0 ORDER BY t.id`)
    .all(owner, conversation, run) as any[];
  const native = db.prepare(`SELECT n.native_id,n.item,n.updated_at,n.run_id
    FROM native_items n JOIN runs r ON r.id=n.run_id AND r.owner_id=?
    WHERE r.conversation_id=? AND r.id=? ORDER BY n.updated_at,n.native_id`)
    .all(owner, conversation, run) as any[];
  return [...traces, ...native.flatMap((row) => {
    const item = JSON.parse(row.item);
    return item.kind === "assistant" && item.text?.trim()
      ? [{ id: `native:${row.native_id}`, content: item.text,
           created_at: row.updated_at, conversation_id: conversation,
           run_id: row.run_id, role: "assistant", metadata: "{}" }] : [];
  })];
}
