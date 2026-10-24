import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "loop-usage-index-"));
process.env.LOOP_DATA_DIR = dir;
const { db, id, emit } = await import("../src/server/db");
const { conversationUsage } = await import("../src/server/mobile-return");
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function conversation(owner: string) {
  const cid = id();
  db.prepare("INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,'Fixture',0)").run(cid, owner);
  return cid;
}
function run(owner: string, cid: string) {
  const rid = id();
  db.prepare("INSERT INTO runs(id,owner_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,'Fixture','completed',?,'{}',0,0)")
    .run(rid, owner, cid, rid);
  return rid;
}

it("uses the usage-only index while preserving receipt totals and conversation ownership", () => {
  const owner = id(), cid = conversation(owner);
  const provider = run(owner, cid), native = run(owner, cid), silent = run(owner, cid);
  const other = run(owner, conversation(owner));
  const foreignOwner = id(), foreignConversation = conversation(foreignOwner);
  const foreign = run(foreignOwner, foreignConversation);
  db.transaction(() => {
    for (let i = 0; i < 128; i++)
      emit(owner, silent, "native.event", {
        conversationId: cid, generation: "fixture",
        event: { type: "item", item: { id: `noise-${i}`, kind: "tool", text: "x".repeat(60_000) } },
      });
  })();
  emit(owner, provider, "provider.receipt", { externalId: "p1", usage: { input_tokens: 100, output_tokens: 20 } });
  emit(owner, provider, "provider.receipt", { usage: { output_tokens: 25 } });
  emit(owner, provider, "provider.receipt", { externalId: "p2", usage: { input_tokens: 50, output_tokens: 9 } });
  emit(owner, native, "native.usage", { usage: { input_tokens: 200, output_tokens: 10 } });
  emit(owner, native, "native.usage", { usage: { input_tokens: 150, output_tokens: 8 } });
  emit(owner, native, "native.usage", { usage: { input_tokens: 250, output_tokens: 40 } });
  emit(owner, native, "provider.receipt", { externalId: "native-receipt", usage: { input_tokens: 999, output_tokens: 999 } });
  emit(owner, other, "native.usage", { usage: { input_tokens: 555, output_tokens: 555 } });
  emit(foreignOwner, foreign, "native.usage", { usage: { input_tokens: 888, output_tokens: 888 } });
  const prepare = db.prepare.bind(db), queries: string[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    if (sql.includes("SELECT e.run_id,e.type,e.payload FROM")) queries.push(sql);
    return prepare(sql);
  });
  try {
    expect(conversationUsage(owner, cid)).toEqual({
      runs: { [provider]: { input_tokens: 150, output_tokens: 34 }, [native]: { input_tokens: 250, output_tokens: 40 } },
      total: { input_tokens: 400, output_tokens: 74 }, memory: [],
    });
    expect(queries).toHaveLength(1);
    const plan = prepare("EXPLAIN QUERY PLAN " + queries[0]).all(owner, cid) as { detail: string }[];
    expect(plan.some(row => /SEARCH e USING INDEX events_usage \(owner_id=\? AND run_id=\?\)/.test(row.detail))).toBe(true);
    expect(plan.some(row => /USING INDEX event_cursor/.test(row.detail))).toBe(false);
    expect(() => conversationUsage(foreignOwner, cid)).toThrow(/not found/i);
    expect(conversationUsage(owner, conversation(owner))).toEqual({ runs: {}, total: { input_tokens: 0, output_tokens: 0 }, memory: [] });
  } finally { spy.mockRestore(); }
});
