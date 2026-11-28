// A Done card is dated and ordered by when its answer was published, not by
// when the answer's message row was created. Native harnesses create that row
// when the turn starts and fill it in, so its created_at is the send time.
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

type DoneItem = {
  conversation_id: string;
  done_card_key: string;
  last_activity_at: number;
  last_message: { id: string; created_at: number } | null;
};

const done = async () => {
  const response = await app.fetch("/api/feed?filter=done");
  return ((await response.json()) as { items: DoneItem[] }).items;
};

it("dates and orders Done cards by when the answer arrived, not when it was asked", async () => {
  const { publishCompletedRunResult } =
    await import("../src/server/result-publication");
  const { db } = fixture;
  const at = (time: number) => vi.mocked(Date.now).mockReturnValue(time);
  const send = (key: string, time: number) => {
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
        "running",
        `key-${key}`,
        JSON.stringify({ connectionId: "conn-api", model: "fixture-model" }),
        time,
        time,
      );
      // The answer's row exists from the start of the turn, still empty.
      db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        `m-${key}`,
        OWNER,
        "c-done-native",
        `r-${key}`,
        "assistant",
        "",
        "{}",
        time + 2_000,
      );
    })();
  };
  const finish = (key: string, time: number) => {
    at(time);
    db.transaction(() => {
      db.prepare(
        "UPDATE messages SET content=?,revision=revision+1 WHERE id=?",
      ).run(`Answer ${key}`, `m-${key}`);
      db.prepare(
        "UPDATE runs SET state='completed',updated_at=? WHERE id=?",
      ).run(time, `r-${key}`);
      publishCompletedRunResult(`r-${key}`, OWNER, db);
    })();
  };
  const sentFirst = NOW + 100_000;
  const sentSecond = NOW + 110_000;
  const secondArrived = NOW + 500_000;
  const firstArrived = NOW + 900_000;
  try {
    // Asked first but answered last: it belongs on top, dated when it arrived.
    send("slow", sentFirst);
    send("quick", sentSecond);
    finish("quick", secondArrived);
    finish("slow", firstArrived);
    at(firstArrived + 60_000);

    const items = (await done()).filter((item) =>
      ["run:r-slow", "run:r-quick"].includes(item.done_card_key),
    );
    expect(items.map((item) => item.done_card_key)).toEqual([
      "run:r-slow",
      "run:r-quick",
    ]);
    expect(items[0]).toMatchObject({
      last_activity_at: firstArrived,
      last_message: { id: "m-slow", created_at: firstArrived },
    });
    expect(items[1]).toMatchObject({
      last_activity_at: secondArrived,
      last_message: { id: "m-quick", created_at: secondArrived },
    });
  } finally {
    at(NOW);
  }
});
