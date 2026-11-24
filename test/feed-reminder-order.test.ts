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
