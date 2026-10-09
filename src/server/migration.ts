import { readdir, readFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { db, id, now } from "./db.js";
import { nativeSessions, OWNER } from "./native-sessions.js";
import { control } from "../host-control.js";
import { config } from "./config.js";
import type { Options } from "../adapters/types.js";
import { Harness, type Item } from "../protocol.js";

export function importSession(
  options: Options,
  nativeId: string,
  items: Item[],
  title: string,
) {
  const existing = db
    .prepare(
      "SELECT conversation_id FROM companion_sessions WHERE harness=? AND native_id=?",
    )
    .get(options.harness, nativeId) as any;
  if (existing) return existing.conversation_id as string;
  const agent = id(),
    conversation = id(),
    name = "resumed-" + id().slice(0, 8);
  const folder = nativeSessions.addProject(options.project) as any;
  const connection = db
    .prepare("SELECT id FROM connections WHERE id=?")
    .get("native-" + options.harness) as any;
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at,folder_id) VALUES(?,?,?,?,?,?,?,'',?,?)",
  ).run(
    agent,
    OWNER,
    name,
    name,
    options.harness === "claude" ? "anthropic" : options.harness,
    connection?.id || null,
    "native-default",
    now(),
    folder.id,
  );
  db.prepare("INSERT INTO handles VALUES(?,?,?)").run(name, agent, now());
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,origin,execution_backend,created_at) VALUES(?,?,?,?,'native','legacy',?)",
  ).run(conversation, OWNER, agent, title, now());
  db.prepare(
    "INSERT INTO companion_sessions(conversation_id,harness,native_id,project,state,updated_at) VALUES(?,?,?,?,'disconnected',?)",
  ).run(conversation, options.harness, nativeId, options.project, now());
  for (const item of items.slice(-2000)) {
    if (!item || typeof item.text !== "string") continue;
    db.prepare("INSERT OR IGNORE INTO native_items VALUES(?,?,NULL,?,?)").run(
      conversation,
      item.id || id(),
      JSON.stringify(item),
      now(),
    );
    if (["user", "assistant"].includes(item.kind))
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id(),
        OWNER,
        conversation,
        item.kind,
        item.text.slice(-256000),
        JSON.stringify({ native: true, migratedProjection: true }),
        now(),
      );
  }
  return conversation;
}
export function resumeFromDesktop(options: Options, nativeId: string) {
  if (!nativeId || nativeId.length > 4096)
    throw new Error("Invalid native session identifier");
  return db
    .transaction(() =>
      importSession(options, nativeId, [], "Native session handoff"),
    )
    .immediate();
}
export async function migrateLegacy(root: string) {
  const projects = join(root, "projects");
  const dirs = await readdir(projects, { withFileTypes: true }).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^[a-f0-9]{20}$/.test(dir.name)) continue;
    const path = join(projects, dir.name);
    if (await control(path, "status").catch(() => undefined))
      throw new Error(
        "A legacy per-project Loop host is still running. Stop it using that version before migration. Its state and native sessions were preserved.",
      );
    const file = join(path, "session.json");
    const raw = await readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    if (!raw) continue;
    if (raw.length > 8 * 1024 * 1024)
      throw new Error(
        "Legacy display snapshot exceeds the migration limit. Original state preserved: " +
          file,
      );
    const digest = createHash("sha256").update(raw).digest("hex");
    const prior = db
      .prepare("SELECT digest FROM legacy_imports WHERE path=?")
      .get(file) as any;
    if (prior) {
      if (prior.digest !== digest)
        console.error(
          "Legacy snapshot changed after migration; preserving both copies without overwriting workspace history: " +
            file,
        );
      continue;
    }
    const snapshot = JSON.parse(raw).snapshot;
    const harness = Harness.parse(snapshot.harness);
    if (!snapshot.nativeSession) continue;
    const backup = join(config.data, "legacy-backups");
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await copyFile(
      file,
      join(backup, dir.name + "-" + digest.slice(0, 12) + ".json"),
    );
    db.transaction(() => {
      const conversation = importSession(
        {
          harness,
          project: snapshot.project,
          executable: "",
          version: snapshot.version,
          billing: snapshot.billing.mode,
        },
        snapshot.nativeSession,
        snapshot.items || [],
        "Migrated " + harness + " conversation",
      );
      db.prepare("INSERT INTO legacy_imports VALUES(?,?,?,?)").run(
        file,
        conversation,
        digest,
        now(),
      );
    }).immediate();
  }
}
