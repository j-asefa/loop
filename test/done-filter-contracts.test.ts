import { expect, it } from "vitest";
import { workspaceApi } from "../src/shared/workspace-api";
import { cardsFixture } from "./helpers/cards-fixture";
import { sealSeededHistory } from "./helpers/published-history";
import {
  seedAgent,
  seedConversation,
  seedMessage,
  seedRun,
} from "./helpers/seed.js";

it("keeps historical Done answers readable when preview Markdown is too deeply nested", async () => {
  const fixture = await cardsFixture(false, { projectedWrites: true });
  const { db, owner, browser, request } = fixture;
  try {
    seedAgent(db, {
      id: "preview-agent",
      owner_id: owner,
      name: "preview-agent",
      normalized_name: "preview-agent",
      provider: "openai",
      model: "fixture",
      created_at: 1,
    });
    seedConversation(db, {
      id: "preview-thread",
      owner_id: owner,
      agent_id: "preview-agent",
      title: "Preview resilience",
      created_at: 1,
    });
    const answers = [
      "An ordinary answer.",
      "Summary.\n\n" + "> ".repeat(10000) + '```spec\n{"op":"add"}',
    ];
    for (const [index, content] of answers.entries()) {
      seedRun(db, {
        id: "preview-run-" + index,
        owner_id: owner,
        agent_id: "preview-agent",
        conversation_id: "preview-thread",
        input: "Read this result",
        state: "completed",
        idempotency_key: "preview-run-" + index,
        created_at: index + 2,
        updated_at: index + 2,
      });
      seedMessage(db, {
        id: "preview-answer-" + index,
        owner_id: owner,
        conversation_id: "preview-thread",
        run_id: "preview-run-" + index,
        role: "assistant",
        content,
        created_at: index + 2,
      });
    }
    // Exercise the upgrade reader for answers written by released versions.
    sealSeededHistory(db);
    const response = await request("/api/v1/cards?view=done", {
      headers: browser,
    });
    expect(response.status).toBe(200);
    const page = workspaceApi.cardList.response.parse(await response.json());
    expect(page.items.map(({ card }) => card.id)).toEqual([
      "d:run:preview-run-1",
      "d:run:preview-run-0",
    ]);
    const card = page.items[0].card;
    expect(card.content).toBe(answers[1]);
    if (card.type !== "done") throw new Error("Expected a Done card");
    expect(card.display.last_message?.preview).toBe("Summary.");
    expect(
      db
        .prepare("SELECT content FROM messages WHERE id=?")
        .get("preview-answer-1"),
    ).toEqual({ content: answers[1] });
  } finally {
    await fixture.close();
  }
});

it("companion filters Done before pagination and reconciles read transitions within the owner and agent selection", async () => {
  const fixture = await cardsFixture(false, { projectedWrites: true });
  const { db, owner, browser, request } = fixture;
  try {
    for (const agent of ["a", "b", "foreign"]) {
      const identity = agent === "foreign" ? "foreign" : owner;
      seedAgent(db, {
        id: agent,
        owner_id: identity,
        name: agent,
        normalized_name: agent,
        provider: "openai",
        model: "fixture",
        created_at: 1,
      });
      seedConversation(db, {
        id: agent,
        owner_id: identity,
        agent_id: agent,
        title: agent,
        created_at: 1,
      });
    }
    const insertMessage = db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Answer',?)",
    );
    db.transaction(() => {
      for (const agent of ["a", "b", "foreign"]) {
        const identity = agent === "foreign" ? "foreign" : owner;
        for (let index = 0; index < 6; index++) {
          const id = agent + index;
          seedRun(db, {
            id,
            owner_id: identity,
            agent_id: agent,
            conversation_id: agent,
            input: "Prompt",
            state: "completed",
            idempotency_key: id,
            created_at: 1,
            updated_at: index + 10,
          });
          insertMessage.run(id, identity, agent, id, index + 10);
        }
      }
    })();
    seedConversation(db, {
      id: "idle",
      owner_id: owner,
      agent_id: "a",
      title: "No result",
      created_at: 1,
    });
    seedMessage(db, {
      id: "idle",
      owner_id: owner,
      conversation_id: "idle",
      role: "user",
      content: "A prompt without an answer",
      created_at: 30,
    });
    // The seeded answers are released history, sealed as an upgrade would.
    sealSeededHistory(db);
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
        (await request("/api/v1/cards?" + query, { headers: browser })).status,
      ).toBe(400);
    // Opening a result removes it from Unread and inserts it into Read.
    expect((await read("a2")).status).toBe(200);
    const unreadDelta = await changes("unread", first.revision);
    expect(unreadDelta.removed).toContain("d:run:a2");
    expect(unreadDelta.items.map((entry) => entry.card.id)).not.toContain(
      "d:run:a2",
    );
    const readDelta = await changes("read", opened.revision);
    expect(readDelta.items.map((entry) => entry.card.id)).toContain("d:run:a2");
    expect(ids(await list({ read: "unread", agent: "a" }))).toEqual([
      "d:run:a4",
      "d:run:a0",
    ]);
    expect(ids(await list({ read: "read", agent: "b" }))).toEqual(["d:run:b5"]);
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
        .prepare("SELECT read_at FROM done_card_reads WHERE owner_id='foreign'")
        .get(),
    ).toEqual({ read_at: 42 });
    expect(
      db
        .prepare(
          "SELECT 1 FROM done_card_unread_versions WHERE owner_id='foreign'",
        )
        .get(),
    ).toBeUndefined();
    expect(ids(await list({ read: "read", agent: "b" }))).toEqual(["d:run:b5"]);
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
}, 30_000);
