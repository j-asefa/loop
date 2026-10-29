import { expect, it } from "vitest";
import { workspaceApi } from "../src/shared/workspace-api";
import { cardsFixture } from "./helpers/cards-fixture";

it.each(["server", "companion", "multi-user"] as const)(
  "%s filters Done before pagination and reconciles read transitions within the owner and agent selection",
  async (mode) => {
    const fixture = await cardsFixture(mode, false, { projectedWrites: true });
    const { db, owner, browser, request } = fixture;
    try {
      for (const agent of ["a", "b", "foreign"]) {
        const identity = agent === "foreign" ? "foreign" : owner;
        db.prepare(
          "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?,'openai','fixture',1)",
        ).run(agent, identity, agent, agent);
        db.prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,1)",
        ).run(agent, identity, agent, agent);
      }
      const insertRun = db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'Prompt','completed',?,1,?)",
      );
      const insertMessage = db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Answer',?)",
      );
      db.transaction(() => {
        for (const agent of ["a", "b", "foreign"]) {
          const identity = agent === "foreign" ? "foreign" : owner;
          for (let index = 0; index < 6; index++) {
            const id = agent + index;
            insertRun.run(id, identity, agent, agent, id, index + 10);
            insertMessage.run(id, identity, agent, id, index + 10);
          }
        }
      })();
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('idle',?,'a','No result',1)",
      ).run(owner);
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('idle',?,'idle','user','A prompt without an answer',30)",
      ).run(owner);
      const read = (id: string, conversation = id[0]) =>
        request(`/api/feed/${conversation}/read`, {
          method: "PUT",
          headers: browser,
          body: { cardKey: "run:" + id },
        });
      for (const id of ["a5", "a3", "a1", "b5"])
        expect((await read(id)).status).toBe(200);
      const list = async (query: Record<string, string> = {}) => {
        const response = await request(
          "/api/v1/cards?" + new URLSearchParams({ view: "done", ...query }),
          { headers: browser },
        );
        expect(response.status).toBe(200);
        return workspaceApi.cardList.response.parse(await response.json());
      };
      const changes = async (read: string, after: string) => {
        const response = await request(
          "/api/v1/cards/changes?" +
            new URLSearchParams({ view: "done", agent: "a", read, after }),
          { headers: browser },
        );
        expect(response.status).toBe(200);
        return workspaceApi.cardChanges.response.parse(await response.json());
      };
      const ids = (page: Awaited<ReturnType<typeof list>>) =>
        page.items.map((entry) => entry.card.id);
      const first = await list({ read: "unread", agent: "a", limit: "2" });
      expect(ids(first)).toEqual(["d:run:a4", "d:run:a2"]);
      expect(first.next).toEqual(expect.any(String));
      const second = await list({
        read: "unread",
        agent: "a",
        limit: "2",
        before: first.next!,
      });
      expect(ids(second)).toEqual(["d:run:a0"]);
      expect(second.next).toBeNull();
      const opened = await list({ read: "read", agent: "a" });
      expect(ids(opened)).toEqual(["d:run:a5", "d:run:a3", "d:run:a1"]);
      const idle = (await list({ agent: "a" })).items.find(
        (entry) => entry.card.source.conversation_id === "idle",
      );
      expect(idle).toBeDefined();
      for (const status of ["read", "unread"])
        expect(ids(await list({ read: status }))).not.toContain(idle!.card.id);
      expect(ids(await list())).not.toEqual(
        expect.arrayContaining(["d:run:foreign5"]),
      );
      // A selection's list and delta cursors cannot be reused for another status.
      expect(
        (
          await request(
            "/api/v1/cards?" +
              new URLSearchParams({
                view: "done",
                agent: "a",
                read: "read",
                before: first.next!,
              }),
            { headers: browser },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            "/api/v1/cards/changes?" +
              new URLSearchParams({
                view: "done",
                agent: "a",
                read: "read",
                after: first.revision,
              }),
            { headers: browser },
          )
        ).status,
      ).toBe(409);
      expect((await read("foreign0", "foreign")).status).toBe(404);
      expect(
        (
          await request("/api/v1/cards?view=done&read=unread&agent=foreign", {
            headers: browser,
          })
        ).status,
      ).toBe(404);
      for (const query of ["view=done&read=invalid", "view=saved&read=read"])
        expect(
          (await request("/api/v1/cards?" + query, { headers: browser }))
            .status,
        ).toBe(400);
      // Opening a result removes it from Unread and inserts it into Read.
      expect((await read("a2")).status).toBe(200);
      const unreadDelta = await changes("unread", first.revision);
      expect(unreadDelta.removed).toContain("d:run:a2");
      expect(unreadDelta.items.map((entry) => entry.card.id)).not.toContain(
        "d:run:a2",
      );
      const readDelta = await changes("read", opened.revision);
      expect(readDelta.items.map((entry) => entry.card.id)).toContain(
        "d:run:a2",
      );
      expect(ids(await list({ read: "unread", agent: "a" }))).toEqual([
        "d:run:a4",
        "d:run:a0",
      ]);
      expect(ids(await list({ read: "read", agent: "b" }))).toEqual([
        "d:run:b5",
      ]);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
