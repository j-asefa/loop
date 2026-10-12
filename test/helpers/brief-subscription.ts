import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export function briefSubscriptionFixture(
  db: Database.Database,
  owner: string,
  provider: "codex" | "anthropic",
  native = false,
  model = "fixture",
) {
  const project = randomUUID(),
    connection = randomUUID(),
    agent = randomUUID(),
    thread = randomUUID(),
    run = randomUUID(),
    artifact = randomUUID();
  db.prepare(
    "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES(?,?,'project','Subscription brief',0)",
  ).run(project, owner);
  db.prepare(
    "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,?,?,'Subscription fixture','','connected',?,?,0)",
  ).run(
    connection,
    owner,
    provider,
    JSON.stringify([{ id: model }]),
    JSON.stringify({
      authMode: "subscription",
      ...(native
        ? { loopHarness: provider === "codex" ? "codex" : "claude" }
        : {}),
    }),
  );
  db.prepare(
    "INSERT INTO agents(id,owner_id,name,normalized_name,provider,connection_id,model,created_at) VALUES(?,?,?,?,'openai',?,'fixture',0)",
  ).run(agent, owner, agent, agent, connection);
  db.prepare(
    "INSERT INTO conversations(id,owner_id,agent_id,title,project_id,created_at) VALUES(?,?,?,'Source',?,0)",
  ).run(thread, owner, agent, project);
  db.prepare(
    "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Source work','completed',?,'{}',0,0)",
  ).run(run, owner, agent, thread, run);
  db.prepare(
    "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,created_at,updated_at) VALUES(?,?,?,?,?,'Source','markdown','Verified work',0,0)",
  ).run(artifact, owner, agent, thread, run);
  db.prepare(
    "INSERT INTO brief_state(owner_id,project_id,connection_id,model,enabled,due_at) VALUES(?,?,?,?,1,0)",
  ).run(owner, project, connection, model);
  return { owner, project, connection, artifact };
}
