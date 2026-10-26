import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { db } from "../db.js";
import { connect, type MCPConnection } from "./client.js";
// Stateful stdio tools (e.g. browser sessions) survive calls and approval pauses
// within a run. Different runs never share a browser or process.
const sessions = new Map<
  string,
  { run: string; secret: string; client: Promise<Client> }
>();
export async function connectForRun(
  c: MCPConnection,
  run: string,
  callId?: string,
) {
  if (JSON.parse(c.metadata).transport !== "stdio")
    return connect(c, run, callId);
  const key = c.owner_id + ":" + c.id + ":" + run;
  const old = sessions.get(key);
  if (old?.secret === c.secret) return old.client;
  if (old) {
    sessions.delete(key);
    await old.client.then((client) => client.close()).catch(() => {});
  }
  const record = { run, secret: c.secret, client: connect(c) };
  sessions.set(key, record);
  try {
    const client = await record.client;
    const priorClose = client.onclose;
    client.onclose = () => {
      if (sessions.get(key) === record) sessions.delete(key);
      priorClose?.();
    };
    return client;
  } catch (error) {
    if (sessions.get(key) === record) sessions.delete(key);
    throw error;
  }
}
export async function closeFinishedSessions() {
  for (const [key, record] of sessions) {
    const run = db
      .prepare("SELECT state FROM runs WHERE id=?")
      .get(record.run) as { state: string } | undefined;
    if (
      !run ||
      ["completed", "failed", "cancelled", "interrupted"].includes(run.state)
    ) {
      sessions.delete(key);
      await record.client.then((client) => client.close()).catch(() => {});
    }
  }
}
