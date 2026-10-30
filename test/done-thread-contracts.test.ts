import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { workspaceApi } from "../src/shared/workspace-api";
import { cardTokenRequest } from "../src/shared/card-access";
import { cardsFixture } from "./helpers/cards-fixture";

it.each(["server", "companion", "multi-user"] as const)(
  "%s persists Done threads without changing conversations and isolates every operation by owner",
  async (mode) => {
    const fixture = await cardsFixture(mode, false, { projectedWrites: true });
    const { db, owner, browser, request } = fixture;
    try {
      for (const [identity, name] of [
        [owner, "basil"],
        [owner, "willow"],
        [owner, "unused"],
        ["foreign", "private"],
      ]) {
        db.prepare(
          "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES(?,?,?,?, 'openai','fixture',1)",
        ).run(name, identity, name, name);
        db.prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,1)",
        ).run(name, identity, name, name);
      }
      db.prepare(
        "INSERT INTO folders(id,owner_id,kind,name,created_at) VALUES('project',?,'project','Project',1),('private-project','foreign','project','Private',1)",
      ).run(owner);
      db.prepare(
        "INSERT INTO folders(id,owner_id,parent_id,kind,name,created_at) VALUES('nested',?,'project','folder','Nested',1)",
      ).run(owner);
      db.prepare(
        "UPDATE conversations SET project_id='nested' WHERE id='basil'",
      ).run();
      db.prepare(
        "INSERT INTO teams(id,owner_id,name,manager_id,created_at) VALUES('team',?,'Team','willow',1),('empty-team',?,'Empty team','unused',1),('private-team','foreign','Private','private',1)",
      ).run(owner, owner);
      db.prepare(
        "UPDATE conversations SET team_id='team' WHERE id='willow'",
      ).run();
      const body = "Full result beyond the preview. ".repeat(180) + "END";
      for (let index = 0; index < 7; index++) {
        const identity = index === 6 ? "foreign" : owner;
        const conversation =
          index === 6 ? "private" : index < 2 ? "basil" : "willow";
        const agent = conversation;
        db.prepare(
          "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          "run" + index,
          identity,
          agent,
          conversation,
          "Prompt " + index,
          index === 5 ? "running" : "completed",
          "run" + index,
          index + 1,
          index + 2,
        );
        db.prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,'assistant',?,'{}',?)",
        ).run(
          "answer" + index,
          identity,
          conversation,
          "run" + index,
          body + index,
          index + 2,
        );
      }
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content,metadata,created_at) VALUES('imported',?,'basil','assistant','Imported answer','{}',20),('prompt',?,'basil','user','Not a result','{}',21)",
      ).run(owner, owner);
      const snapshot = () =>
        ["conversations", "runs", "messages"].map((table) =>
          db.prepare("SELECT * FROM " + table + " ORDER BY id").all(),
        );
      const before = snapshot();
      const root = "/api/feed/threads";
      const id = randomUUID(),
        second = randomUUID();
      const create = (thread: string, cardIds: string[]) =>
        request(root, {
          headers: browser,
          body: { id: thread, title: "Basil and Willow", cardIds },
        });
      const move = (thread: string, cardIds: string[]) =>
        request(`${root}/${thread}/cards`, {
          headers: browser,
          body: { cardIds },
        });
      const list = async (query = "") => {
        const response = await request(root + query, { headers: browser });
        expect(response.status).toBe(200);
        return workspaceApi.doneThreadList.response.parse(
          await response.json(),
        );
      };
      const detail = async (thread: string) => {
        const response = await request(`${root}/${thread}`, {
          headers: browser,
        });
        expect(response.status).toBe(200);
        return workspaceApi.doneThreadDetail.response.parse(
          await response.json(),
        );
      };
      const first = await create(id, ["d:run:run1", "d:run:run0"]);
      expect(first.status).toBe(200);
      expect(
        workspaceApi.doneThreadCreate.response.parse(await first.json())
          .cardIds,
      ).toHaveLength(2);
      expect((await list()).map((thread) => thread.id)).toEqual([id]);
      expect((await list())[0].preview?.id).toBe("d:run:run1");
      // A newer, ungrouped result in the original conversation does not replace
      // this thread's saved preview or membership.
      expect((await list())[0].preview?.source.message_id).toBe("answer1");
      const read = await detail(id);
      expect(read.cards.map((card) => card.id)).toEqual([
        "d:run:run0",
        "d:run:run1",
      ]);
      expect(read.cards.map((card) => card.content)).toEqual([
        body + 0,
        body + 1,
      ]);
      expect(
        read.cards.every((card) => card.source.conversation_id === "basil"),
      ).toBe(true);
      // Opening a thread reads every member and nothing outside it.
      const unread = (key: string, identity = owner) =>
        db
          .prepare(
            "SELECT unread FROM feed_cards WHERE owner_id=? AND kind='result' AND card_key=?",
          )
          .get(identity, key);
      expect((await list())[0].unread).toBe(2);
      expect(
        read.cards.map((card) => card.type === "done" && card.display.read_at),
      ).toEqual([null, null]);
      const opened = await request(`${root}/${id}/read`, {
        method: "PUT",
        headers: browser,
        body: {},
      });
      expect(opened.status).toBe(200);
      expect(
        workspaceApi.doneThreadRead.response.parse(await opened.json()),
      ).toEqual({ ok: true });
      expect((await list())[0].unread).toBe(0);
      // Marking a group unread clears only its members and is idempotent.
      db.prepare(
        "INSERT INTO done_card_reads VALUES(?, 'basil', 'message:imported', 42)",
      ).run(owner);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(`${root}/${id}/read`, {
          method: "DELETE",
          headers: browser,
        });
        expect(response.status).toBe(200);
        expect(
          workspaceApi.doneThreadUnread.response.parse(await response.json()),
        ).toEqual({ ok: true });
      }
      expect((await list())[0].unread).toBe(2);
      expect(
        (await detail(id)).cards.map(
          (card) => card.type === "done" && card.display.read_at,
        ),
      ).toEqual([null, null]);
      expect([unread("run:run0"), unread("run:run1")]).toEqual([
        { unread: 1 },
        { unread: 1 },
      ]);
      expect(unread("message:imported")).toEqual({ unread: 0 });
      expect(
        (
          await request(`${root}/${id}/read`, {
            method: "PUT",
            headers: browser,
            body: {},
          })
        ).status,
      ).toBe(200);
      const readCards = (await detail(id)).cards;
      expect(
        readCards.map((card) => card.type === "done" && card.display.read_at),
      ).toEqual([expect.any(Number), expect.any(Number)]);
      expect([unread("run:run0"), unread("run:run1")]).toEqual([
        { unread: 0 },
        { unread: 0 },
      ]);
      expect(unread("run:run2")).toEqual({ unread: 1 });
      // A tab that loaded the individual cards before grouping can still dismiss
      // them. Saved membership and its preview must survive those valid writes.
      for (const index of [0, 1]) {
        const dismissed = await request("/api/feed/basil", {
          method: "PATCH",
          headers: browser,
          body: { cardKey: "run:run" + index, hidden: true },
        });
        expect(dismissed.status).toBe(200);
      }
      expect((await list())[0]).toMatchObject({
        id,
        cardIds: expect.arrayContaining(["d:run:run0", "d:run:run1"]),
        preview: { id: "d:run:run1" },
      });
      expect((await detail(id)).cards).toEqual(readCards);
      const dismissedFeed = await request("/api/v1/cards?view=done", {
        headers: browser,
      });
      expect(dismissedFeed.status).toBe(200);
      const dismissedCards = workspaceApi.cardList.response.parse(
        await dismissedFeed.json(),
      );
      for (const index of [0, 1]) {
        expect(
          dismissedCards.items.map((entry) => entry.card.id),
        ).not.toContain("d:run:run" + index);
        expect(
          (
            await request("/api/v1/cards/d%3Arun%3Arun" + index, {
              headers: browser,
            })
          ).status,
        ).toBe(404);
      }
      expect((await move(id, ["d:run:run0"])).status).toBe(200);
      for (const index of [0, 1]) {
        expect(
          (
            await request("/api/feed/basil", {
              method: "PATCH",
              headers: browser,
              body: { cardKey: "run:run" + index, hidden: false },
            })
          ).status,
        ).toBe(200);
      }
      expect((await move(id, ["d:run:run2"])).status).toBe(200);
      expect((await list())[0].preview?.id).toBe("d:run:run2");
      expect((await list("?agent=basil"))[0]).toMatchObject({
        cardIds: expect.arrayContaining([
          "d:run:run0",
          "d:run:run1",
          "d:run:run2",
        ]),
        preview: { id: "d:run:run1", source: { agent_id: "basil" } },
      });
      expect((await list("?agent=willow"))[0].preview?.id).toBe("d:run:run2");
      // Nonmatching groups remain destinations but do not enter a filtered feed.
      expect((await list("?agent=unused"))[0].preview).toBeNull();
      expect((await list("?project=project"))[0].preview?.id).toBe(
        "d:run:run1",
      );
      expect((await list("?project=nested"))[0].preview?.id).toBe("d:run:run1");
      expect((await list("?teams=team"))[0].preview?.id).toBe("d:run:run2");
      expect((await list("?teams=empty-team"))[0].preview).toBeNull();
      expect(
        (await list("?agent=willow&project=project"))[0].preview,
      ).toBeNull();
      for (const query of [
        "agent=private",
        "project=private-project",
        "teams=private-team",
      ])
        expect(
          (await request(root + "?" + query, { headers: browser })).status,
        ).toBe(404);
      db.prepare(
        "UPDATE teams SET hide_results_from_feed=1 WHERE id='team'",
      ).run();
      expect((await list())[0]).toMatchObject({
        cardIds: expect.arrayContaining(["d:run:run2"]),
        preview: { id: "d:run:run1" },
      });
      expect((await list("?teams=team"))[0].preview?.id).toBe("d:run:run2");
      expect((await list("?agent=willow"))[0].preview?.id).toBe("d:run:run2");
      expect((await detail(id)).cards).toHaveLength(3);
      db.prepare(
        "UPDATE teams SET hide_results_from_feed=0 WHERE id='team'",
      ).run();
      // Repeating a creation after a lost response must not move its old members again.
      expect((await create(id, ["d:run:run0", "d:run:run1"])).status).toBe(200);
      expect((await detail(id)).cards).toHaveLength(3);
      expect((await create(second, ["d:run:run3", "d:run:run4"])).status).toBe(
        200,
      );
      const moved = await move(second, [
        "d:run:run0",
        "d:run:run1",
        "d:message:imported",
      ]);
      expect(moved.status).toBe(200);
      expect(
        workspaceApi.doneThreadMove.response.parse(await moved.json()).cardIds,
      ).toHaveLength(5);
      expect((await list()).map((thread) => thread.id)).toEqual([second]);
      expect(
        (await request(`${root}/${id}`, { headers: browser })).status,
      ).toBe(404);
      expect((await create(id, ["d:run:run0", "d:run:run1"])).status).toBe(404);
      expect((await detail(second)).cards).toHaveLength(5);

      // Validation and inaccessible members cannot partially move cards or create groups.
      for (const invalid of [
        "d:run:run6",
        "d:run:missing",
        "d:run:run5",
        "d:message:prompt",
      ]) {
        expect((await move(second, ["d:run:run2", invalid])).status).toBe(404);
        const failed = randomUUID();
        expect((await create(failed, ["d:run:run2", invalid])).status).toBe(
          404,
        );
        expect(
          db.prepare("SELECT id FROM done_threads WHERE id=?").get(failed),
        ).toBeUndefined();
        expect(
          db
            .prepare("SELECT id FROM done_thread_creations WHERE id=?")
            .get(failed),
        ).toBeUndefined();
      }
      expect(
        (await create(randomUUID(), ["d:run:run2", "d:run:run2"])).status,
      ).toBe(400);
      expect((await move(second, Array(101).fill("d:run:run2"))).status).toBe(
        400,
      );
      expect((await move(second, [])).status).toBe(400);
      expect((await list())[0].cardIds).not.toContain("d:run:run2");

      const foreign = randomUUID();
      db.prepare(
        "INSERT INTO done_thread_creations(id,owner_id) VALUES(?,'foreign')",
      ).run(foreign);
      db.prepare(
        "INSERT INTO done_threads(id,owner_id,title,created_at) VALUES(?,'foreign','Private thread',1)",
      ).run(foreign);
      db.prepare(
        "INSERT INTO done_thread_members(owner_id,card_id,thread_id,conversation_id) VALUES('foreign','d:run:run6',?,'private')",
      ).run(foreign);
      expect((await list()).map((thread) => thread.id)).toEqual([second]);
      for (const [path, options] of [
        [`${root}/${foreign}`, {}],
        [`${root}/${foreign}`, { method: "DELETE" }],
        [`${root}/${foreign}/cards/d%3Arun%3Arun6`, { method: "DELETE" }],
        [`${root}/${foreign}/cards`, { body: { cardIds: ["d:run:run2"] } }],
        [`${root}/${foreign}/read`, { method: "PUT", body: {} }],
        [`${root}/${foreign}/read`, { method: "DELETE" }],
        [
          root,
          {
            body: {
              id: foreign,
              title: "Not yours",
              cardIds: ["d:run:run0", "d:run:run1"],
            },
          },
        ],
      ] as const) {
        const response = await request(path, { ...options, headers: browser });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("Private thread");
      }
      expect(
        db
          .prepare(
            "SELECT card_id FROM done_thread_members WHERE owner_id='foreign'",
          )
          .all(),
      ).toEqual([{ card_id: "d:run:run6" }]);
      expect(unread("run:run6", "foreign")).toEqual({ unread: 1 });
      // A bearer grant for published cards cannot read or organize private Done threads.
      const token = await request("/api/card-tokens", {
        headers: browser,
        body: cardTokenRequest("Cards", "cards:read"),
      });
      expect(token.status).toBe(201);
      const { secret } = await token.json();
      for (const [path, options] of [
        [root, {}],
        [`${root}/${second}`, {}],
        [`${root}/${second}`, { method: "DELETE" }],
        [`${root}/${second}/cards`, { body: { cardIds: ["d:run:run2"] } }],
        [`${root}/${second}/read`, { method: "PUT", body: {} }],
      ] as const) {
        expect(
          (
            await request(path, {
              ...options,
              headers: { authorization: "Bearer " + secret },
            })
          ).status,
        ).not.toBe(200);
      }

      const removed = await request(`${root}/${second}/cards/d%3Arun%3Arun0`, {
        method: "DELETE",
        headers: browser,
      });
      expect(removed.status).toBe(200);
      expect(
        workspaceApi.doneThreadRemoveCard.response.parse(await removed.json()),
      ).toEqual({ ok: true });
      expect((await detail(second)).cards).toHaveLength(4);
      const deleted = await request(`${root}/${second}`, {
        method: "DELETE",
        headers: browser,
      });
      expect(deleted.status).toBe(200);
      expect(
        workspaceApi.doneThreadRemove.response.parse(await deleted.json()),
      ).toEqual({ ok: true });
      expect(await list()).toEqual([]);
      expect((await create(second, ["d:run:run3", "d:run:run4"])).status).toBe(
        404,
      );
      expect(snapshot()).toEqual(before);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
