import { expect, it } from "vitest";
import { cardsFixture } from "./helpers/cards-fixture";
import { seedCards } from "./helpers/seed-cards";

it("advertises a refresh source consistent with the actual companion action", async () => {
  const fixture = await cardsFixture();
  try {
    await seedCards(fixture, 1);
    const { db, owner, browser } = fixture;
    // A refreshable card is a saved tool artifact: its role arm holds the
    // connection/tool/arguments metadata the refresh route reads (D5).
    db.prepare("UPDATE artifacts SET role='trace' WHERE id='result-000'").run();
    const metadata = (value: object) =>
      db
        .prepare("UPDATE artifacts SET metadata=? WHERE id='result-000'")
        .run(JSON.stringify(value));
    const read = async () =>
      (
        await (
          await fixture.request("/api/v1/cards/a:result-000", {
            headers: browser,
          })
        ).json()
      ).display.refreshable;
    const refresh = (key: string) =>
      fixture.request("/api/artifacts/result-000/refresh", {
        headers: browser,
        body: { idempotencyKey: key },
      });
    metadata({ connectionId: "ordinary-model-account" });
    expect(await read()).toBe(false);
    expect((await refresh("ordinary-answer-refresh")).status).toBe(400);
    db.prepare(
      "INSERT INTO mcp_connections(id,owner_id,name,url,secret,status,tools,created_at) VALUES('refresh-source',?,'Fixture','http://127.0.0.1:1/mcp','','connected',?,1)",
    ).run(
      owner,
      JSON.stringify([
        { name: "fixture-tool", inputSchema: { type: "object" } },
      ]),
    );
    const source = {
      connectionId: "refresh-source",
      tool: "fixture-tool",
      arguments: {},
    };
    metadata(source);
    expect(await read()).toBe(true);
    const queued = await refresh("valid-refresh-source");
    expect(queued.status).toBe(200);
    const run = await queued.json();
    const stored = db
      .prepare("SELECT payload FROM runs WHERE id=? AND owner_id=?")
      .get(run.id, owner) as { payload: string };
    expect(JSON.parse(stored.payload)).toMatchObject({
      connectionId: "refresh-source",
      tool: "fixture-tool",
      arguments: {},
    });
    metadata({ ...source, arguments: [] });
    // Cards now consume the same strict metadata schema as artifact actions.
    // Corrupt stored arguments are rejected, not advertised as a valid card.
    const invalidCard = await fixture.request("/api/v1/cards/a:result-000", {
      headers: browser,
    });
    expect(invalidCard.status).toBe(400);
    expect(await invalidCard.json()).toMatchObject({
      error: expect.stringContaining("expected record"),
    });
    const invalid = await refresh("invalid-refresh-arguments");
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({
      error: expect.stringContaining("result-000"),
    });
    // A source descriptor never grants access to the tool connection.
    metadata(source);
    db.prepare(
      "UPDATE mcp_connections SET owner_id='foreign' WHERE id='refresh-source'",
    ).run();
    expect((await refresh("foreign-refresh-source")).status).toBe(404);
  } finally {
    await fixture.close();
  }
}, 30000);
