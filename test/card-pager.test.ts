import { afterEach, expect, it, vi } from "vitest";
import { CardPager } from "../src/client/card-pager";
import {
  CardEntrySchema,
  type CardEntry,
  type CardPage,
  type CardChanges,
} from "../src/shared/cards";

const entry = (key: string, at: number, content = key): CardEntry =>
  CardEntrySchema.parse({
    card: {
      id: "m:" + key,
      type: "message",
      role: "user",
      content,
      format: "markdown",
      created_at: at,
      updated_at: null,
      author: { kind: "owner", id: null, name: null, provider: null },
      recipient: null,
      source: {
        agent_id: null,
        artifact_id: null,
        message_id: key,
        conversation_id: "thread",
        run_id: "run",
      },
      context: {
        conversation_title: "Thread",
        folder_id: null,
        project_id: null,
        project_name: null,
        team_id: null,
      },
      saved: true,
      attachments: [],
      href: "/?conversation=thread",
    },
    order: [at, "m:" + key],
    saved: { at, label: null },
  });

it("restores a committed loaded window and reconciles its boundary without another backfill", async () => {
  const pager = new CardPager();
  const changes = async (after: string) => ({
    revision: after,
    items: [],
    removed: [],
    more: false,
  });
  await pager.load(
    "saved-owner-source",
    "saved",
    false,
    async () => ({
      items: [entry("a", 100), entry("b", 90)],
      next: "older",
      revision: "first",
    }),
    changes,
  );
  await pager.load(
    "saved-owner-source",
    "saved",
    true,
    async () => ({
      items: [entry("c", 80)],
      next: "oldest",
      revision: "newer-page",
    }),
    changes,
  );
  const saved = pager.snapshot()!;
  pager.reset();
  const restored = new CardPager();
  restored.restore("saved-owner-source", saved);
  const page = vi.fn(async () => {
    throw new Error("Unexpected backfill");
  });
  const result = await restored.load(
    "saved-owner-source",
    "saved",
    false,
    page,
    async (after) => {
      expect(after).toBe("first");
      return {
        revision: "second",
        removed: ["m:b"],
        more: false,
        items: [entry("a", 100, "Edited"), entry("too-old", 1)],
      };
    },
  );
  expect(page).not.toHaveBeenCalled();
  expect(result?.items.map((item) => item.card.id)).toEqual(["m:a", "m:c"]);
  expect(result?.next).toBe("oldest");
  expect(restored.snapshot()?.boundary).toEqual([80, "m:c"]);
});
const page = (
  items: CardEntry[],
  next: string | null = null,
  revision = "first",
): CardPage => ({ items, next, revision });
const delta = (
  revision: string,
  items: CardEntry[] = [],
  removed: string[] = [],
  more = false,
): CardChanges => ({ items, removed, revision, more });
const unchanged = async (revision: string) => delta(revision);
afterEach(() => vi.useRealTimers());

it.each(["saved", "sent"] as const)(
  "keeps the %s tuple window bounded while refreshing loaded and newer entries",
  async (view) => {
    const pager = new CardPager();
    const pages = vi.fn(async (before: string | null) =>
      before
        ? page([entry("older", 20)], null, "later-page")
        : page([entry("z", 100), entry("b", 50)], "next"),
    );
    await pager.load("owner:source:selection", view, false, pages, unchanged);
    const changes = vi.fn(async () =>
      delta("second", [
        entry("z", 100, "edited"),
        entry("new", 110),
        entry("a", 50),
        entry("older", 20),
      ]),
    );
    const updated = await pager.load(
      "owner:source:selection",
      view,
      false,
      pages,
      changes,
    );
    expect(updated!.items.map((e) => e.card.id)).toEqual([
      "m:new",
      "m:z",
      "m:b",
    ]);
    expect(updated!.items.find((e) => e.card.id === "m:z")!.card.content).toBe(
      "edited",
    );
    expect(changes).toHaveBeenCalledWith("first", undefined);
    const extended = await pager.load(
      "owner:source:selection",
      view,
      true,
      pages,
      async (after) => {
        expect(after).toBe("second"); // Ignore the append page's newer watermark.
        return delta(
          "third",
          [entry("older", 20, "edited during append")],
          ["m:b"],
        );
      },
    );
    expect(extended!.items.map((e) => e.card.id)).toEqual([
      "m:new",
      "m:z",
      "m:older",
    ]);
    expect(extended!.items.at(-1)!.card.content).toBe("edited during append");
    expect(extended!.next).toBeNull();
    const all = await pager.load(
      "owner:source:selection",
      view,
      false,
      pages,
      async () => delta("fourth", [entry("oldest", 1)]),
    );
    expect(all!.items.at(-1)!.card.id).toBe("m:oldest");
  },
);

it("passes the extended Results bound before advancing revisions", async () => {
  const pager = new CardPager();
  const changes = vi.fn(unchanged);
  const pages = vi.fn(async (before: string | null) =>
    before
      ? page([entry("10", 10)], "last", "newer")
      : page([entry("100", 100)], "older"),
  );
  await pager.load("results", "results", false, pages, changes);
  expect(changes).toHaveBeenLastCalledWith("first", 100);
  await pager.load("results", "results", true, pages, changes);
  expect(changes).toHaveBeenLastCalledWith("first", 10);
});

it("discards active and coalesced requests after changing owner, source or filters", async () => {
  const pager = new CardPager();
  let finish!: (page: CardPage) => void;
  const pending = () =>
    new Promise<CardPage>((resolve) => {
      finish = resolve;
    });
  const old = pager.load(
    "alice:source1:all",
    "saved",
    false,
    pending,
    unchanged,
  );
  const queued = pager.load(
    "alice:source1:all",
    "saved",
    true,
    pending,
    unchanged,
  );
  const current = await pager.load(
    "bob:source2:project",
    "saved",
    false,
    async () => page([]),
    unchanged,
  );
  finish(page([entry("private", 100)]));
  expect(await old).toBeNull();
  expect(await queued).toBeNull();
  expect(current!.items).toEqual([]);
});

it("does not commit an append until its bounded reconciliation succeeds", async () => {
  const pager = new CardPager();
  const pages = vi.fn(async (before: string | null) =>
    before
      ? page([entry("old", 1)], null, "newer")
      : page([entry("new", 100)], "older"),
  );
  await pager.load("key", "saved", false, pages, unchanged);
  await expect(
    pager.load("key", "saved", true, pages, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  const retried = await pager.load("key", "saved", true, pages, unchanged);
  expect(pages).toHaveBeenLastCalledWith("older");
  expect(retried!.items).toHaveLength(2);
});

it("advances irrelevant batches silently and resets after an invalid revision", async () => {
  const pager = new CardPager();
  const pages = vi.fn(async () => page([entry("new", 100)], "older"));
  await pager.load("key", "sent", false, pages, unchanged);
  expect(
    await pager.load("key", "sent", false, pages, async (after) =>
      delta(
        "advanced",
        [entry("old", 1)],
        ["m:not-loaded"],
        after !== "advanced",
      ),
    ),
  ).toBeNull();
  await expect(
    pager.load("key", "sent", false, pages, async (after) => {
      expect(after).toBe("advanced");
      throw Object.assign(new Error("Resynchronize"), { status: 409 });
    }),
  ).rejects.toThrow("Resynchronize");
  await pager.load("key", "sent", false, pages, unchanged);
  expect(pages).toHaveBeenCalledTimes(2);
  expect(pages).toHaveBeenLastCalledWith(null);
});

it("coalesces refreshes without starving slow reads or losing append intent", async () => {
  vi.useFakeTimers();
  const pager = new CardPager();
  const pages = vi.fn(async (before: string | null) =>
    before ? page([entry("old", 1)], null) : page([entry("new", 100)], "older"),
  );
  await pager.load("key", "sent", false, pages, unchanged);
  let active = 0,
    maximum = 0,
    revision = 0;
  const changes = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2400));
    active--;
    return delta(String(++revision), [
      entry("new", 100, "revision " + revision),
    ]);
  };
  const committed: string[] = [];
  const timer = setInterval(() => {
    void pager.load("key", "sent", false, pages, changes).then((result) => {
      if (result) committed.push(result.revision);
    });
  }, 1800);
  await vi.advanceTimersByTimeAsync(10800);
  clearInterval(timer);
  await vi.advanceTimersByTimeAsync(6000);
  expect(maximum).toBe(1);
  expect(committed.length).toBeGreaterThanOrEqual(3);
  expect(pages).toHaveBeenCalledTimes(1);
  const refresh = pager.load("key", "sent", false, pages, changes);
  const append = pager.load("key", "sent", true, pages, changes);
  const coalesced = pager.load("key", "sent", false, pages, changes);
  await vi.advanceTimersByTimeAsync(6000);
  await refresh;
  expect((await append)!.items).toHaveLength(2);
  expect(await coalesced).toEqual(await append);
});

it("drains one invalidation through every bounded changes page before publishing", async () => {
  const pager = new CardPager();
  const page = async () => ({
    items: [entry("a", 100)],
    next: null,
    revision: "0",
  });
  let calls = 0;
  const changes = async (): Promise<CardChanges> => {
    calls++;
    return {
      items: [entry("b" + calls, 100 + calls)],
      removed: calls === 3 ? ["m:a"] : [],
      revision: String(calls),
      more: calls < 4,
    };
  };
  const result = await pager.load(
    "owner:source",
    "saved",
    false,
    page,
    changes,
  );
  expect(calls).toBe(4);
  expect(result!.items).toHaveLength(4);
  expect(result!.items.some((item) => item.card.id === "m:a")).toBe(false);
  expect(result!.revision).toBe("4");
});
