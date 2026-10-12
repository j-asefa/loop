import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each(["main", "direct-mail preview"])("upgrades populated %s mail with foreign keys enabled, preserving identities, row order and dependent records", (source) => {
  const dir = mkdtempSync(join(tmpdir(), "loop-mail-upgrade-"));
  const db = new Database(join(dir, "loop.db"));
  const request = JSON.stringify({
    to: "b",
    body: "Question",
    interrupt: false,
    fileIds: ["11111111-1111-4111-8111-111111111111"],
  });
  try {
    db.pragma("foreign_keys=ON");
    db.transaction(() => {
      for (const name of readdirSync("migrations")
        .filter((n) => n.endsWith(".sql") && Number(n.split("-")[0]) < (source === "main" ? 83 : 80))
        .sort())
        db.exec(readFileSync(join("migrations", name), "utf8"));
    }).immediate();
    db.exec(`
      INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('a','owner','A','a','openai','fixture',1),('b','owner','B','b','openai','fixture',1);
      INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES('team','owner','Team','a',1);
      INSERT INTO team_members VALUES('team','b');
      INSERT INTO conversations(id,owner_id,agent_id,title,created_at,team_id) VALUES('ca','owner','a','A',1,'team'),('cb','owner','b','B',1,'team');
      INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('source','owner','a','ca','Task','completed','source',1,1),('target','owner','b','cb','Task','completed','target',1,1);
      INSERT INTO delegations VALUES('source','delegate','target','{}',1);
      INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES('input','owner','cb','target','user','Question',1);
      INSERT INTO run_steering(id,owner_id,run_id,message_id,idempotency_key,request,state,created_at) VALUES('steer','owner','target','input','steer','{}','delivered',1);
      INSERT INTO agent_threads(rowid,id,owner_id,team_id,subject,created_by,paused_at,paused_reason,resumed_at,created_at,updated_at) VALUES(9,'thread','owner','team','Subject','a',20,'Limit',10,1,20);
      INSERT INTO agent_thread_members(rowid,thread_id,agent_id,conversation_id) VALUES(4,'thread','a','ca'),(8,'thread','b','cb');
    `);
    const insert = db.prepare(
      "INSERT INTO agent_mail(rowid,id,owner_id,team_id,thread_id,kind,sender_agent_id,sender_run_id,sender_conversation_id,recipient_agent_id,recipient_conversation_id,body,file_ids,interrupt,idempotency_key,request,state,error,delivery,run_id,steering_id,requeued_run_id,created_at,sent_at) VALUES(?,?,'owner','team','thread',?,'a','source','ca','b','cb','Question',?,0,?,?,?,?,'queued','target',?,?,100,100)",
    );
    insert.run(
      3,
      "sent",
      "message",
      '["11111111-1111-4111-8111-111111111111"]',
      "mail:source:old-call",
      request,
      "sent",
      null,
      null,
      null,
    );
    insert.run(
      7,
      "held",
      "message",
      "[]",
      "held",
      "{}",
      "held",
      null,
      null,
      null,
    );
    insert.run(
      12,
      "refused",
      "message",
      "[]",
      "refused",
      "{}",
      "refused",
      "Retired",
      null,
      null,
    );
    insert.run(
      19,
      "result",
      "result",
      "[]",
      "result:target:completed",
      "result:target:completed",
      "sent",
      null,
      "steer",
      "target",
    );
    db.prepare(
      "INSERT INTO native_calls(run_id,call_id,tool,arguments,result) VALUES('source','old-call','loop_message',?,?)",
    ).run(request, '{"receipt":"immutable"}');
    if (source === "direct-mail preview")
      db.transaction(() => db.exec(
        readFileSync("migrations/083-direct-agent-mail.sql", "utf8")
          .replace("VALUES(83,", "VALUES(80,"),
      )).immediate();
    const tables = [
      "agent_threads",
      "agent_thread_members",
      "agent_mail",
      "delegations",
      "native_calls",
      "run_steering",
    ];
    const columns = Object.fromEntries(
      tables.map((t) => [
        t,
        (db.pragma(`table_info(${t})`) as { name: string }[]).map(
          (c) => c.name,
        ),
      ]),
    );
    const snapshot = () =>
      Object.fromEntries(
        tables.map((t) => [
          t,
          db
            .prepare(
              `SELECT rowid,${columns[t].join(",")} FROM ${t} ORDER BY rowid`,
            )
            .all(),
        ]),
      );
    const before = snapshot();
    const env = { ...process.env, LOOP_PROFILE: "server", LOOP_DATA_DIR: dir };
    for (let i = 0; i < 2; i++)
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          "const {db}=await import('./src/server/db.ts');if(db.pragma('foreign_key_check').length)throw Error('foreign keys');db.close();",
        ],
        { env },
      );
    expect(db.prepare("SELECT version FROM schema_version WHERE version>=80 ORDER BY version").all())
      .toEqual([{ version: 80 }, { version: 81 }, { version: 82 }, { version: 83 }]);
    expect(snapshot()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT scope FROM agent_threads").get()).toEqual({
      scope: "team",
    });
    expect(
      (db.pragma("index_list(agent_mail)") as { name: string }[]).map(
        (i) => i.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "agent_mail_thread",
        "agent_mail_sender_run",
        "agent_mail_team",
        "agent_mail_steering",
        "agent_mail_pending",
      ]),
    );
    const receipt = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const {db}=await import('./src/server/db.ts');const {sendMail}=await import('./src/server/agent-mail.ts');console.log(JSON.stringify(sendMail(db.prepare("SELECT * FROM runs WHERE id='source'").get(),'old-call',${request})));db.close();`,
      ],
      { env, encoding: "utf8" },
    );
    expect(JSON.parse(receipt)).toMatchObject({
      messageId: "sent",
      threadId: "thread",
      delivery: "queued",
    });
    expect(snapshot()).toEqual(before);
    expect(() =>
      db
        .prepare(
          "INSERT INTO agent_threads(id,owner_id,scope,team_id,subject,created_by,created_at,updated_at) VALUES('bad','owner','direct','team','bad','a',1,1)",
        )
        .run(),
    ).toThrow(/CHECK/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
