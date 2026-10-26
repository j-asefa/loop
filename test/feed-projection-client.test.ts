import { expect, it } from "vitest";
import { FeedProjectionReader } from "../src/client/feed-projection";
import { setViewOwner } from "../src/client/viewCache";
const page = (id: string, epoch = "epoch", cursor = 1) => ({
  items: [{ conversation_id: id, text: id }],
  projection: { epoch, cursor },
  projectionRows: {
    selection: id,
    delta: false,
    removed: [],
    entities: [
      { id: JSON.stringify([id, null]), signature: id, revision: cursor },
    ],
  },
});
it("keeps per-source/per-page cursors and rejects late snapshots, owner changes and source replacement", async () => {
  setViewOwner("reader-owner");
  const reader = new FeedProjectionReader<
    { conversation_id: string; text: string },
    ReturnType<typeof page>
  >();
  await reader.read("one", "/feed", async () => page("newest"));
  await reader.read("one", "/feed?before=older", async () => page("older"));
  await reader.read("two", "/feed", async () => page("other", "second"));
  let resolve!: (p: ReturnType<typeof page>) => void;
  const late = reader.read(
    "one",
    "/feed",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const rejected = expect(late).rejects.toThrow("Obsolete");
  await reader.read("one", "/feed", async (known) => {
    expect(JSON.parse(known!).selection).toBe("newest");
    return page("newest", "epoch", 2);
  });
  resolve(page("stale"));
  await rejected;
  await reader.read("one", "/feed?before=older", async (known) => {
    expect(JSON.parse(known!).selection).toBe("older");
    return page("older");
  });
  const replacement = reader.read(
    "two",
    "/feed",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const replaced = expect(replacement).rejects.toThrow("Obsolete");
  reader.reset("two");
  resolve(page("other", "second"));
  await replaced;
  const ownerRead = reader.read(
    "one",
    "/feed",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const ownerRejected = expect(ownerRead).rejects.toThrow("Obsolete");
  setViewOwner("next-owner");
  resolve(page("private"));
  await ownerRejected;
  await reader.read("one", "/feed", async (known) => {
    expect(known).toBeUndefined();
    return page("new-owner");
  });
});
