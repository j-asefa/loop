import { Router } from "express";
import { z } from "zod";
import { db, id, now } from "./db.js";
import { nativeSessions, OWNER } from "./native-sessions.js";
import { Problem } from "./domain.js";
import { Codex } from "../adapters/codex.js";
import { importSession } from "./migration.js";
import type { Item } from "../protocol.js";
import { codexActivities } from "../adapters/direct-activities.js";
import { directActivityUpdate } from "../activity-bridge.js";
import {
  reduceActivities,
  type ActivityUpdate,
} from "../agent-activities.js";
import { applyActivity } from "./activities.js";
export const nativeHistory = Router();
let inspecting = false;
async function inspect<T>(fn: (native: Codex) => Promise<T>) {
  if (inspecting)
    throw new Problem(409, "Native history is busy; try again shortly.");
  const options = nativeSessions.registration("codex");
  inspecting = true;
  const native = new Codex({ ...options, probeOnly: true }, () => {});
  try {
    await native.start();
    return await fn(native);
  } finally {
    await native.dispose();
    inspecting = false;
  }
}
function projection(thread: any): Item[] {
  const result: Item[] = [];
  for (const turn of thread.turns || [])
    for (const item of turn.items || []) {
      if (item.type === "agentMessage")
        result.push({ id: item.id, kind: "assistant", text: item.text || "" });
      else if (item.type === "userMessage")
        result.push({
          id: item.id,
          kind: "user",
          text: (item.content || [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n"),
        });
    }
  return result.slice(-500).map((i) => ({ ...i, text: i.text.slice(-64000) }));
}
// Structured command/file records saved in a native thread, as replayed
// display history. Codex keeps no plan in thread items, so none is invented.
/** @internal Exported for tests. */
export function historyActivities(thread: any): ActivityUpdate[] {
  const updates: ActivityUpdate[] = [];
  for (const turn of thread.turns || [])
    for (const item of turn.items || [])
      for (const activity of codexActivities("item/completed", { item }))
        updates.push(
          directActivityUpdate(activity, { harness: "codex", replay: true }),
        );
  return updates.slice(-500);
}
// Read-only view for a thread Loop does not own, folded by the shared reducer.
export function historyProjection(thread: any) {
  const records = reduceActivities(
    historyActivities(thread).map((update) => ({ update, turn: "history" })),
  );
  return [...records].map(([key, record]) => ({ key, kind: record.kind, record }));
}
nativeHistory.get("/native/history", async (req, res) => {
  const managed = db
    .prepare(
      "SELECT n.conversation_id id,n.harness,n.project,n.state,c.title FROM companion_sessions n JOIN conversations c ON c.id=n.conversation_id ORDER BY n.updated_at DESC LIMIT 200",
    )
    .all();
  if (req.query.discover !== "1")
    return res.json({ managed, external: [], next: null });
  const cursor = z.string().max(4096).optional().parse(req.query.cursor);
  const result = await inspect((native) =>
    native.inspect("thread/list", {
      cursor,
      limit: 50,
      modelProviders: [],
      sortKey: "updated_at",
    }),
  );
  const external = db
    .transaction(() =>
      (result.data || [])
        .map((t: any) => {
          if (!t.id || typeof t.cwd !== "string") return null;
          const existing = db
            .prepare(
              "SELECT conversation_id FROM companion_sessions WHERE harness='codex' AND native_id=?",
            )
            .get(t.id) as any;
          if (existing) return null;
          db.prepare(
            "INSERT INTO native_catalog(id,harness,native_id,project,title,updated_at) VALUES(?,'codex',?,?,?,?) ON CONFLICT(harness,native_id) DO UPDATE SET project=excluded.project,title=excluded.title,updated_at=excluded.updated_at",
          ).run(
            id(),
            t.id,
            t.cwd,
            String(t.name || t.preview || "Codex conversation").slice(0, 180),
            now(),
          );
          return db
            .prepare(
              "SELECT id,harness,project,title FROM native_catalog WHERE harness='codex' AND native_id=?",
            )
            .get(t.id);
        })
        .filter(Boolean),
    )
    .immediate();
  res.json({
    managed,
    external,
    next: result.nextCursor || null,
    note: "Saved native Codex history across directories. External live ownership cannot be established; read or fork without taking over the original.",
  });
});
nativeHistory.get("/native/history/:id", async (req, res) => {
  const record = db
    .prepare("SELECT * FROM native_catalog WHERE id=?")
    .get(req.params.id) as any;
  if (!record) throw new Problem(404, "Native history entry not found");
  const data = await inspect((native) =>
    native.inspect("thread/read", {
      threadId: record.native_id,
      includeTurns: true,
    }),
  );
  res.json({
    items: projection(data.thread),
    activities: historyProjection(data.thread),
    note: "Read from native history. Large paginated native threads may require the native client for their complete history.",
  });
});
nativeHistory.post("/native/history/:id/fork", async (req, res) => {
  const { commandId } = z
    .object({ commandId: z.string().uuid() })
    .strict()
    .parse(req.body);
  const record = db
    .prepare("SELECT * FROM native_catalog WHERE id=?")
    .get(req.params.id) as any;
  if (!record) throw new Problem(404, "Native history entry not found");
  const old = db
    .prepare("SELECT * FROM native_history_actions WHERE id=?")
    .get(commandId) as any;
  if (old) {
    if (old.catalog_id !== record.id)
      throw new Problem(
        409,
        "Command identity belongs to another conversation",
      );
    if (old.conversation_id) return res.json({ id: old.conversation_id });
    throw new Problem(
      409,
      "Previous fork outcome is uncertain. Inspect native history before making a new fork.",
    );
  }
  const project = nativeSessions.directory(record.project);
  const conversation = await inspect(async (native) => {
    db.prepare(
      "INSERT INTO native_history_actions VALUES(?,?,'unknown',NULL,?)",
    ).run(commandId, record.id, now());
    const result = await native.inspect("thread/fork", {
      threadId: record.native_id,
    });
    return db
      .transaction(() => {
        const conversation = importSession(
          { ...nativeSessions.registration("codex"), project },
          result.thread.id,
          projection(result.thread),
          "Fork: " + record.title,
        );
        // Display history only: replayed records never mark tools as newly run.
        for (const update of historyActivities(result.thread))
          applyActivity({ owner: OWNER, conversation }, update);
        db.prepare(
          "UPDATE native_history_actions SET state='completed',conversation_id=? WHERE id=?",
        ).run(conversation, commandId);
        return conversation;
      })
      .immediate();
  });
  res.status(201).json({ id: conversation });
});
