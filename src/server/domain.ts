import { z } from "zod";
import { db, id, now } from "./db.js";
import type { Agent, Connection } from "../shared/types.js";
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
    public diagnostic?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export function owned<T>(table: string, recordId: string, owner: string): T {
  const tables = [
    "agents",
    "connections",
    "conversations",
    "runs",
    "messages",
    "artifacts",
    "objects",
    "folders",
    "imports",
    "workflows",
    "mcp_connections",
    "approvals",
    "operations",
    "teams",
    "runtime_hosts",
    "memory_sources",
  ];
  if (!tables.includes(table)) throw new Error("Invalid resource");
  const record = db
    .prepare(`SELECT * FROM ${table} WHERE id=? AND owner_id=?`)
    .get(recordId, owner);
  if (!record) throw new Problem(404, "Item not found");
  return record as T;
}
const reserved = new Set([
  "admin",
  "loop",
  "support",
  "system",
  "everyone",
  "all",
  "api",
  "new",
  "deleted",
  "settings",
]);
export const handle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9-]{2,31}$/,
    "Use 3–32 lowercase letters, numbers or hyphens, starting with a letter",
  )
  .refine((x) => !reserved.has(x), "This name is reserved");
export const agentInput = z.object({
  name: handle,
  connectionId: z.string(),
  model: z.string().min(1).max(150),
  effort: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .nullable()
    .optional(),
  instructions: z.string().max(12000).default(""),
  folderId: z.string().optional(),
});
export function createAgent(owner: string, value: unknown) {
  const data = agentInput.parse(value);
  if (data.folderId) owned("folders", data.folderId, owner);
  const connection = owned<Connection>("connections", data.connectionId, owner);
  if (connection.status !== "connected")
    throw new Problem(409, "Reconnect this provider first");
  const models = JSON.parse(connection.models) as { id: string }[];
  if (!models.some((m) => m.id === data.model))
    throw new Problem(400, "Choose an available model from this connection");
  validateEffort(connection, data.model, data.effort);
  return db
    .transaction(() => {
      if (db.prepare("SELECT 1 FROM handles WHERE name=?").get(data.name))
        throw new Problem(409, "That name is taken. Choose another name.");
      const agentId = id();
      db.prepare(
        "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,instructions,created_at,folder_id,effort) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        agentId,
        owner,
        data.name,
        data.name,
        connection.provider,
        connection.id,
        data.model,
        data.instructions,
        now(),
        data.folderId || null,
        data.effort || null,
      );
      db.prepare("INSERT INTO handles VALUES(?,?,?)").run(
        data.name,
        agentId,
        now(),
      );
      return owned<Agent>("agents", agentId, owner);
    })
    .immediate();
}
export function validateEffort(
  connection: Connection,
  model: string,
  effort?: string | null,
) {
  const selected = (
    JSON.parse(connection.models) as import("../shared/models.js").ModelOption[]
  ).find((option) => option.id === model);
  if (
    effort &&
    selected?.effortLevels &&
    !selected.effortLevels.some((option) => option.value === effort)
  )
    throw new Problem(400, "Choose an effort level reported by this model");
}
export function renameAgent(owner: string, agentId: string, name: unknown) {
  const normalized = handle.parse(name);
  const agent = owned<Agent>("agents", agentId, owner);
  return db
    .transaction(() => {
      const occupied = db
        .prepare("SELECT agent_id FROM handles WHERE name=?")
        .get(normalized) as { agent_id: string } | undefined;
      if (occupied && occupied.agent_id !== agentId)
        throw new Problem(409, "That name is taken or reserved");
      db.prepare("INSERT OR IGNORE INTO handles VALUES(?,?,?)").run(
        normalized,
        agentId,
        now(),
      );
      db.prepare("UPDATE agents SET name=?,normalized_name=? WHERE id=?").run(
        normalized,
        normalized,
        agentId,
      );
      return { ...agent, name: normalized };
    })
    .immediate();
}
