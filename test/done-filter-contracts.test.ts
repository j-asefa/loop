import { expect, it } from "vitest";
import { workspaceApi } from "../src/shared/workspace-api";
import { cardsFixture } from "./helpers/cards-fixture";

it.each(["companion"] as const)(
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
      const read = (id: string, conversation = id[0], unreadVersion?: number) =>
        request(`/api/feed/${conversation}/read`, {
          method: "PUT",
          headers: browser,
          body: { cardKey: "run:" + id, unreadVersion },
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
      const markUnread = (id: string, conversation = id[0]) =>
        request(`/api/feed/${conversation}/read`, {
          method: "DELETE",
          headers: browser,
          body: { cardKey: "run:" + id },
        });
      const summary = async () => {
        const response = await request("/api/feed?filter=done&agent=a", {
          headers: browser,
        });
        expect(response.status).toBe(200);
        return workspaceApi.feed.response.parse(await response.json()).summary;
      };
      const beforeUnread = await list({ read: "unread", agent: "a" });
      const beforeRead = await list({ read: "read", agent: "a" });
      const count = (await summary()).done_unread!;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await markUnread("a2");
        expect(response.status).toBe(200);
        expect(
          workspaceApi.feedUnread.response.parse(await response.json()),
        ).toEqual({ ok: true, unreadVersions: { "d:run:a2": attempt + 1 } });
        // Even an already-unread result publishes the new decision version.
        const delta = await changes("unread", beforeUnread.revision);
        expect(
          delta.items.find((entry) => entry.card.id === "d:run:a2")?.card,
        ).toMatchObject({
          display: { read_at: null, unread_version: attempt + 1 },
        });
      }
      // The authoritative card stream moves the same result between both
      // selections; a repeated unread action never increments the badge twice.
      expect((await summary()).done_unread).toBe(count + 1);
      expect(ids(await list({ read: "unread", agent: "a" }))).toEqual([
        "d:run:a4",
        "d:run:a2",
        "d:run:a0",
      ]);
      expect(ids(await list({ read: "read", agent: "a" }))).toEqual([
        "d:run:a5",
        "d:run:a3",
        "d:run:a1",
      ]);
      expect((await changes("read", beforeRead.revision)).removed).toContain(
        "d:run:a2",
      );
      expect((await changes("unread", beforeUnread.revision)).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            card: expect.objectContaining({
              id: "d:run:a2",
              display: expect.objectContaining({ read_at: null }),
            }),
          }),
        ]),
      );
      // Reject other owners, mismatched conversations and missing results.
      db.prepare(
        "INSERT INTO done_card_reads VALUES('foreign','foreign','run:foreign0',42)",
      ).run();
      for (const [id, conversation] of [
        ["foreign0", "foreign"],
        ["a2", "b"],
        ["missing", "a"],
      ])
        expect((await markUnread(id, conversation)).status).toBe(404);
      expect(
        db
          .prepare(
            "SELECT read_at FROM done_card_reads WHERE owner_id='foreign'",
          )
          .get(),
      ).toEqual({ read_at: 42 });
      expect(
        db
          .prepare(
            "SELECT 1 FROM done_card_unread_versions WHERE owner_id='foreign'",
          )
          .get(),
      ).toBeUndefined();
      expect(ids(await list({ read: "read", agent: "b" }))).toEqual([
        "d:run:b5",
      ]);
      await fixture.restart();
      expect(ids(await list({ read: "unread", agent: "a" }))).toContain(
        "d:run:a2",
      );
      expect((await summary()).done_unread).toBe(count + 1);
      // Delayed reads from older tabs, including a missing legacy version,
      // cannot erase the newer unread decision, even after a server restart.
      for (const version of [undefined, 0, 1, 3]) {
        expect((await read("a2", "a", version)).status).toBe(200);
        expect((await summary()).done_unread).toBe(count + 1);
      }
      const latest = (await list({ agent: "a" })).items.find(
        (entry) => entry.card.id === "d:run:a2",
      )!.card;
      expect(latest).toMatchObject({ display: { unread_version: 2 } });
      // A deliberate reopen from the latest card snapshot reads it normally.
      expect((await read("a2", "a", 2)).status).toBe(200);
      expect((await summary()).done_unread).toBe(count);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
