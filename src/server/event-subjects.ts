import type Database from "better-sqlite3";
import { WORKSPACE_COLLECTIONS, WorkspaceSubject } from "../shared/workspace-events.js";

/** Ownership evidence is process-local, immutable, and cannot be forged over JSON. */
export function eventSubjects(db: Database.Database) {
  const evidence = new WeakMap<object, { owner: string; subject: WorkspaceSubject }>();
  const tables: Partial<Record<WorkspaceSubject["kind"], string>> = {
    run: "runs", conversation: "conversations", message: "messages", artifact: "artifacts",
    approval: "approvals", later: "later_items", scheduled_send: "scheduled_sends",
    mail_thread: "agent_threads", connection: "connections", agent: "agents", folder: "folders", team: "teams",
  };
  function prove(owner: string, input: WorkspaceSubject) {
    const subject = WorkspaceSubject.parse(input);
    const table = tables[subject.kind];
    const owned = table
      ? db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND owner_id=?`).get(subject.id, owner)
      : subject.kind === "decision"
        ? db.prepare("SELECT 1 FROM native_decisions d JOIN runs r ON r.id=d.run_id WHERE d.id=? AND r.owner_id=?").get(subject.id, owner)
        : subject.kind === "social"
          ? db.prepare("SELECT 1 FROM feed_sources WHERE id=? AND owner_id=?").get(subject.id, owner)
          : subject.kind === "collection" && ["all", ...WORKSPACE_COLLECTIONS].includes(subject.id);
    if (!owner || !owned) throw new Error("Workspace event subject is not owned by its producer");
    const proof = Object.freeze({ ...subject });
    evidence.set(proof, { owner, subject: proof });
    return proof;
  }
  return {
    prove,
    resolve(owner: string, input: string | WorkspaceSubject) {
      if (typeof input === "string") return prove(owner, { kind: "run", id: input });
      const proof = evidence.get(input);
      if (proof) {
        if (proof.owner !== owner) throw new Error("Workspace event ownership evidence belongs to another owner");
        return proof.subject;
      }
      return prove(owner, input);
    },
  };
}
