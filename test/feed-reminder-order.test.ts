// A reminder that comes due lifts its conversation's newest Done card to the
// top, through the production later writes and the stored feed projection.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createFeedFixture, NOW, OWNER } from "./helpers/feed-fixture";
import { productionApp } from "./helpers/app";

let fixture: Awaited<ReturnType<typeof createFeedFixture>>;
let app: Awaited<ReturnType<typeof productionApp>>;

beforeAll(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  fixture = await createFeedFixture();
  app = await productionApp(OWNER);
  const { changes, deadlines } = await import("../src/server/db");
  deadlines.close();
  changes.close();
});
afterAll(async () => {
  await app.close();
  fixture.close();
  vi.restoreAllMocks();
});

const done = async () => {
  const response = await app.fetch("/api/feed?filter=done");
  const body = (await response.json()) as {
    items: {
      conversation_id: string;
      done_card_key: string;
      later: { surfaced_at: number | null; created_at?: number } | null;
    }[];
  };
  return body.items;
};

it("moves a surfaced reminder's newest result to the top and back when it is finished", async () => {
  const { createLater, surfaceLater, finishLater } =
    await import("../src/server/mobile-return/later");
  const before = await done();
  expect(before.at(-1)?.conversation_id).toBe("c-done-api");

  const reminder = createLater(OWNER, {
    kind: "conversation",
    targetId: "c-done-api",
    condition: "time",
    dueAt: NOW + 60_000,
  });
  // Done keeps a snoozed card where it was until its reminder comes due.
  expect((await done()).map((item) => item.conversation_id)).toEqual(
    before.map((item) => item.conversation_id),
  );

  surfaceLater(NOW + 120_000);
  const reminded = await done();
  expect(reminded[0]).toMatchObject({
    conversation_id: "c-done-api",
    later: { surfaced_at: NOW + 120_000, created_at: NOW },
  });
  // Only the newest card moves; the rest keep their order.
  expect(reminded.slice(1).map((item) => item.conversation_id)).toEqual(
    before.slice(0, -1).map((item) => item.conversation_id),
  );

  finishLater(OWNER, reminder.id);
  expect((await done()).map((item) => item.conversation_id)).toEqual(
    before.map((item) => item.conversation_id),
  );
});

it("drops a lifted card back when newer results arrive and labels only the lifted card", async () => {
  const { createLater, surfaceLater, finishLater } =
    await import("../src/server/mobile-return/later");
  const { publishCompletedRunResult } =
    await import("../src/server/result-publication");
  const { db } = fixture;
  const order = async () =>
    (await done()).map(
      (item) => `${item.conversation_id} ${item.done_card_key}`,
    );
  // A card says "Reminded" only when the reminder set its time.
  const labelled = async () =>
    (await done())
      .filter(
        (item) =>
          item.conversation_id === "c-done-native" &&
          item.later?.surfaced_at != null &&
          (item as { last_activity_at?: number }).last_activity_at ===
            item.later.surfaced_at,
      )
      .map((item) => item.done_card_key);
  const original = await order();
  const at = (time: number) => vi.mocked(Date.now).mockReturnValue(time);
  const answer = (key: string, time: number) => {
    at(time);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        `r-${key}`,
        OWNER,
        "agent-api",
        "c-done-native",
        "agent",
        `Prompt ${key}`,
        "completed",
        `key-${key}`,
        JSON.stringify({ connectionId: "conn-api", model: "fixture-model" }),
        time,
        time,
      );
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        `m-${key}`,
        OWNER,
        "c-done-native",
        `r-${key}`,
        "assistant",
        `Answer ${key}`,
        "{}",
        time,
      );
      publishCompletedRunResult(`r-${key}`, OWNER, db);
    })();
  };
  try {
    at(NOW);
    const reminder = createLater(OWNER, {
      kind: "conversation",
      targetId: "c-done-native",
      condition: "time",
      dueAt: NOW + 60_000,
    });
    surfaceLater(NOW + 120_000);
    expect((await order())[0]).toBe("c-done-native run:r-done-native");
    expect(await labelled()).toEqual(["run:r-done-native"]);

    // Two newer answers: neither is lifted past its own time, the old one
    // drops back, and no card claims the reminder.
    answer("newer-1", NOW + 200_000);
    answer("newer-2", NOW + 300_000);
    const after = await order();
    expect(after.slice(0, 2)).toEqual([
      "c-done-native run:r-newer-2",
      "c-done-native run:r-newer-1",
    ]);
    expect(after.slice(2)).toEqual(original);
    expect(await labelled()).toEqual([]);

    finishLater(OWNER, reminder.id);
    expect((await order()).slice(2)).toEqual(original);
  } finally {
    at(NOW);
  }
});
