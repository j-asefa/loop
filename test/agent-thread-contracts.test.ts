import { expect, it } from "vitest";
import { workspaceApi } from "../src/shared/workspace-api";
import { integrationTokenRequest } from "../src/shared/card-access";
import { cardsFixture } from "./helpers/cards-fixture";

it("companion groups only explicit mail in its thread, including interrupts into shared running history", async () => {
  const fixture = await cardsFixture(false, { projectedWrites: true });
  const { db, owner, request, browser } = fixture;
  try {
    for (const [agent, identity] of [
      ["basil", owner],
      ["willow", owner],
      ["private", "foreign"],
    ]) {
      db.prepare(
        "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'openai','fixture',1)",
      ).run(agent, identity, agent, agent);
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,1)",
      ).run(agent, identity, agent, "Unrelated conversation");
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,'Unrelated task','running',?,'{}',1,1)",
      ).run(agent, identity, agent, agent, agent);
    }
    db.prepare(
      "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('project',?,'project','Project',1),('other-project',?,'project','Other',1),('foreign-project','foreign','project','Private',1)",
    ).run(owner, owner);
    db.prepare(
      "UPDATE conversations SET project_id='project' WHERE id='basil'",
    ).run();
    db.prepare(
      "INSERT INTO teams(id,owner_id,name,manager_id,hide_results_from_feed,created_at) VALUES('hidden',?,'Hidden','basil',1,1),('foreign-team','foreign','Private','private',0,1)",
    ).run(owner);
    const insertThread = db.prepare(
      "INSERT INTO agent_threads(id,owner_id,scope,team_id,subject,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'basil',1,1)",
    );
    for (const id of [
      "exchange",
      "separate",
      "waiting",
      "older",
      "newer",
      "hidden",
      "foreign",
    ])
      insertThread.run(
        id,
        id === "foreign" ? "foreign" : owner,
        id === "hidden" ? "team" : "direct",
        id === "hidden" ? "hidden" : null,
        id === "foreign" ? "PRIVATE SUBJECT" : id,
      );
    const insert =
      db.prepare(`INSERT INTO agent_mail(id,owner_id,thread_id,kind,sender_agent_id,sender_run_id,sender_conversation_id,recipient_agent_id,recipient_conversation_id,body,file_ids,interrupt,idempotency_key,request,state,run_id,created_at)
        VALUES(?,?,?,'message',?,?,?,? ,?,?,'[]',1,?,'PRIVATE_REQUEST_CONTEXT',?,?,?)`);
    const mail = (
      id: string,
      thread: string,
      body: string,
      time: number,
      identity = owner,
      state = "sent",
      from = "basil",
      to = "willow",
    ) =>
      insert.run(
        id,
        identity,
        thread,
        from,
        from,
        from,
        to,
        to,
        body,
        id,
        state,
        to,
        time,
      );
    const full = "Only this exchange. ".repeat(100) + "END OF MAIL";
    mail("question", "exchange", full, 10);
    mail(
      "answer",
      "exchange",
      "Explicit linked reply",
      10,
      owner,
      "sent",
      "willow",
      "basil",
    );
    mail("other", "separate", "OTHER EXCHANGE SAME RUN", 12);
    mail("waiting", "waiting", "Not dispatched", 15, owner, "pending");
    mail("older", "older", "Earlier exchange", 1);
    mail("newer", "newer", "Later exchange", 20);
    mail("hidden", "hidden", "Hidden team exchange", 25);
    mail(
      "private",
      "foreign",
      "PRIVATE MAIL",
      30,
      "foreign",
      "sent",
      "private",
      "private",
    );
    // Even an inconsistent legacy child row cannot cross the owner's boundary.
    mail(
      "forged-owner",
      "exchange",
      "PRIVATE CHILD",
      40,
      "foreign",
      "sent",
      "private",
      "private",
    );
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('before',?,'willow','willow','assistant','UNRELATED BEFORE','{}',1),('incoming',?,'willow','willow','user','Wrapped mail','{\"automation\":{\"mailId\":\"question\",\"threadId\":\"exchange\"}}',10),('after',?,'willow','willow','assistant','UNRELATED FINAL ANSWER','{}',50)",
    ).run(owner, owner, owner);
    db.prepare(
      "INSERT INTO artifacts(id,owner_id,title,kind,content,created_at,updated_at) VALUES('file',?,'Shared note','file','note',1,1),('private-file','foreign','PRIVATE FILE','file','secret',1,1)",
    ).run(owner);
    db.prepare(
      "UPDATE agent_mail SET file_ids='[\"file\",\"private-file\"]' WHERE id='question'",
    ).run();
    const original = () =>
      ["conversations", "runs", "messages", "agent_mail", "agent_threads"].map(
        (table) => db.prepare("SELECT * FROM " + table + " ORDER BY id").all(),
      );
    const before = original();
    const root = "/api/feed/agent-threads";
    const list = async (query = "") => {
      const response = await request(root + query, { headers: browser });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(JSON.stringify(json)).not.toMatch(/PRIVATE|UNRELATED/);
      return workspaceApi.agentThreadFeed.response.parse(json);
    };
    // The separate exchange may appear in the list, but never in this reader.
    const all = await list();
    expect(all.items.map((thread) => thread.id)).toEqual([
      "newer",
      "waiting",
      "separate",
      "exchange",
      "older",
    ]);
    const exchange = all.items.find((thread) => thread.id === "exchange")!;
    expect(exchange.message_count).toBe(2);
    expect(exchange.latest.id).toBe("answer");
    expect(exchange.participants.map((person) => person.name)).toEqual([
      "basil",
      "willow",
    ]);
    expect(
      (await list("?view=done")).items.map((thread) => thread.id),
    ).not.toContain("waiting");
    expect(
      (await list("?agent=willow")).items.map((thread) => thread.id),
    ).toContain("hidden");
    expect(
      (await list("?teams=hidden")).items.map((thread) => thread.id),
    ).toEqual(["hidden"]);
    expect((await list("?project=project")).items).toHaveLength(5);
    expect((await list("?project=other-project")).items).toEqual([]);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(
        "?limit=2" + (cursor ? "&before=" + encodeURIComponent(cursor) : ""),
      );
      ids.push(...page.items.map((thread) => thread.id));
      cursor = page.next;
    } while (cursor);
    expect(ids).toEqual(all.items.map((thread) => thread.id));
    const detail = async (query = "") => {
      const response = await request(root + "/exchange" + query, {
        headers: browser,
      });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(JSON.stringify(json)).not.toMatch(
        /PRIVATE|UNRELATED|OTHER EXCHANGE SAME RUN/,
      );
      return workspaceApi.agentThreadDetail.response.parse(json);
    };
    const first = await detail("?limit=1");
    expect(first.messages.map((message) => message.id)).toEqual(["answer"]);
    const second = await detail(
      "?limit=1&before=" + encodeURIComponent(first.next!),
    );
    expect(second.messages).toMatchObject([
      {
        id: "question",
        content: full,
        message_id: "incoming",
        attachments: [{ id: "file", name: "Shared note" }],
      },
    ]);
    expect(second.next).toBeNull();
    expect((await detail()).messages.map((message) => message.id)).toEqual([
      "question",
      "answer",
    ]);
    for (const path of [
      "/foreign",
      "?agent=private",
      "?project=foreign-project",
      "?teams=foreign-team",
    ])
      expect((await request(root + path, { headers: browser })).status).toBe(
        404,
      );
    for (const path of [
      "?before=invalid",
      "?limit=101",
      "/exchange?before=invalid",
    ])
      expect((await request(root + path, { headers: browser })).status).toBe(
        400,
      );
    const tokenResponse = await request("/api/card-tokens", {
      headers: browser,
      body: integrationTokenRequest("Cards", ["read"]),
    });
    const { secret } = await tokenResponse.json();
    for (const path of [root, root + "/exchange"])
      expect(
        (
          await request(path, {
            headers: { authorization: "Bearer " + secret },
          })
        ).status,
      ).not.toBe(200);
    expect(original()).toEqual(before);
    mail("follow-up", "exchange", "New linked reply", 60);
    expect((await list()).items[0]).toMatchObject({
      id: "exchange",
      message_count: 3,
      latest: { id: "follow-up" },
    });
    expect((await detail()).messages.map((message) => message.id)).toEqual([
      "question",
      "answer",
      "follow-up",
    ]);

    // Direct mail has no thread.team_id. Its actual conversation contexts
    // still obey team visibility, with explicit agent/team selections allowed.
    db.prepare(
      "UPDATE conversations SET team_id='hidden' WHERE owner_id=? AND id IN ('basil','willow')",
    ).run(owner);
    expect((await list("?view=done")).items).toEqual([]);
    expect((await list("?view=threads")).items).toEqual([]);
    expect((await list("?project=project")).items).toEqual([]);
    for (const query of [
      "?agent=willow",
      "?teams=hidden",
      "?project=project&teams=hidden",
    ])
      expect((await list(query)).items.map((item) => item.id)).toContain(
        "exchange",
      );
    db.prepare(
      "UPDATE teams SET hide_results_from_feed=0 WHERE id='hidden'",
    ).run();
    expect((await list()).items.map((item) => item.id)).toContain("exchange");
    db.prepare(
      "UPDATE teams SET hide_results_from_feed=1 WHERE id='hidden'",
    ).run();

    // A mixed exchange remains visible through its public context, but that
    // context cannot make the hidden team's project view visible too.
    db.prepare(
      "UPDATE conversations SET team_id=NULL WHERE owner_id=? AND id='willow'",
    ).run(owner);
    expect((await list()).items.map((item) => item.id)).toContain("exchange");
    expect((await list("?project=project")).items).toEqual([]);
    expect(
      (await list("?project=project&teams=hidden")).items.map(
        (item) => item.id,
      ),
    ).toContain("exchange");

    // An unavailable recipient has no conversation yet. That missing context
    // must not act as a public conversation for a hidden sender's exchange.
    db.prepare(
      "UPDATE agent_mail SET recipient_conversation_id=NULL WHERE id='waiting'",
    ).run();
    expect((await list()).items.map((item) => item.id)).not.toContain(
      "waiting",
    );
    expect(
      (await list("?teams=hidden")).items.map((item) => item.id),
    ).toContain("waiting");
  } finally {
    await fixture.close();
  }
}, 30_000);
