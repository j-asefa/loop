import { afterEach, expect, it, vi } from "vitest";
import {
  ResultsPager,
  type ResultsPage,
  type ResultsUpdates,
} from "../src/client/results";
type Card = { id: string; cursor: number; content: string };
const cards = (count: number): Card[] =>
  Array.from({ length: count }, (_, i) => ({
    id: String(count - i),
    cursor: count - i,
    content: "original",
  }));
const pageFrom = (items: Card[], revision = 1) =>
  vi.fn(async (before: number | null): Promise<ResultsPage<Card>> => {
    const page = items
      .filter((c) => before === null || c.cursor < before)
      .slice(0, 40);
    return {
      items: page,
      next: page.length === 40 ? page.at(-1)!.cursor : null,
      revision,
    };
  });
const noChanges = async (after: number): Promise<ResultsUpdates<Card>> => ({
  items: [],
  removed: [],
  revision: after,
  more: false,
});
afterEach(() => vi.useRealTimers());

it("reconciles edited and removed older cards without refetching their pages", async () => {
  const source = cards(100),
    page = pageFrom(source),
    feed = new ResultsPager<Card>();
  expect(
    (await feed.load("alice:all", false, page, noChanges))!.items,
  ).toHaveLength(40);
  expect(
    (await feed.load("alice:all", true, page, noChanges))!.items,
  ).toHaveLength(80);
  const updates = vi.fn(async (): Promise<ResultsUpdates<Card>> => ({
    items: [{ id: "25", cursor: 25, content: "user edit" }],
    removed: ["90", "30"],
    revision: 2,
    more: false,
  }));
  const refreshed = (await feed.load("alice:all", false, page, updates))!;
  expect(refreshed.items).toHaveLength(78);
  expect(refreshed.items.find((c) => c.id === "25")!.content).toBe("user edit");
  expect(refreshed.items.some((c) => c.id === "90" || c.id === "30")).toBe(
    false,
  );
  expect(refreshed.next).toBe(21);
  expect(page).toHaveBeenCalledTimes(2);
  expect(updates).toHaveBeenCalledWith(1, 21);
  const end = (await feed.load("alice:all", true, page, updates))!;
  expect(end.items).toHaveLength(98);
  expect(end.next).toBeNull();
  expect(end.revision).toBe(2); // An older page's watermark cannot rewind the feed.
});

it("uses one bounded changes request per refresh even with 21 loaded pages", async () => {
  const page = pageFrom(cards(1000)),
    feed = new ResultsPager<Card>();
  const updates = vi.fn(noChanges);
  await feed.load("alice:all", false, page, updates);
  for (let i = 0; i < 20; i++)
    await feed.load("alice:all", true, page, updates);
  for (let i = 0; i < 34; i++) {
    const result = await feed.load("alice:all", false, page, updates);
    expect(result).toBeNull();
  }
  expect(page).toHaveBeenCalledTimes(21);
  expect(updates).toHaveBeenCalledTimes(34);
});

it.each([1000, 2400])(
  "commits live snapshots at %s ms latency while refreshes arrive every 1800 ms",
  async (delay) => {
    vi.useFakeTimers();
    const feed = new ResultsPager<Card>();
    const page = pageFrom(cards(100));
    await feed.load("alice:all", false, page, noChanges);
    await feed.load("alice:all", true, page, noChanges);
    let active = 0,
      maxActive = 0,
      revision = 1;
    const updates = vi.fn(async (): Promise<ResultsUpdates<Card>> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delay));
      active--;
      revision++;
      return {
        items: [{ id: "100", cursor: 100, content: "chunk " + revision }],
        removed: [],
        revision,
        more: false,
      };
    });
    const committed: number[] = [];
    const timer = setInterval(() => {
      void feed.load("alice:all", false, page, updates).then((result) => {
        if (result) committed.push(result.revision);
      });
    }, 1800);
    await vi.advanceTimersByTimeAsync(10800);
    expect(committed.length).toBeGreaterThanOrEqual(3);
    expect(maxActive).toBe(1);
    expect(page).toHaveBeenCalledTimes(2);
    clearInterval(timer);
    await vi.advanceTimersByTimeAsync(6000);
    expect(committed).toEqual([...committed].sort((a, b) => a - b));
    expect(active).toBe(0);
  },
);

it("discards both active and queued work after an owner/filter change", async () => {
  const feed = new ResultsPager<Card>();
  let finish!: (page: ResultsPage<Card>) => void;
  const pending = vi.fn(
    () => new Promise<ResultsPage<Card>>((r) => (finish = r)),
  );
  const old = feed.load("alice:all", false, pending, noChanges);
  const queued = feed.load("alice:all", false, pending, noChanges);
  const current = await feed.load(
    "bob:files",
    false,
    pageFrom([], 7),
    noChanges,
  );
  finish({
    items: [{ id: "private", cursor: 1, content: "old" }],
    next: null,
    revision: 1,
  });
  expect(await old).toBeNull();
  expect(await queued).toBeNull();
  expect(current).toEqual({ items: [], next: null, revision: 7 });
  expect(feed.key).toBe("bob:files");
  expect(pending).toHaveBeenCalledTimes(1);
});

it("retries a failed active request once for coalesced callers without dropping pagination intent", async () => {
  const feed = new ResultsPager<Card>(),
    page = pageFrom(cards(100));
  await feed.load("alice:all", false, page, noChanges);
  let fail!: (error: Error) => void;
  const updates = () =>
    new Promise<ResultsUpdates<Card>>((_r, reject) => (fail = reject));
  const failed = feed.load("alice:all", false, page, updates);
  const failure = expect(failed).rejects.toThrow("offline");
  const append = feed.load("alice:all", true, page, noChanges);
  const coalesced = feed.load("alice:all", false, page, noChanges);
  fail(new Error("offline"));
  await failure;
  expect((await append)!.items).toHaveLength(80);
  expect(await coalesced).toEqual(await append);
  expect(page).toHaveBeenCalledTimes(2);
});

it("includes older newly matching cards when the complete filtered feed is loaded", async () => {
  const feed = new ResultsPager<Card>();
  const page = pageFrom([
    { id: "100", cursor: 100, content: "existing match" },
  ]);
  await feed.load("alice:files", false, page, noChanges);
  const updates = vi.fn(
    async (_after: number, through: number): Promise<ResultsUpdates<Card>> => ({
      items:
        through === 0
          ? [{ id: "20", cursor: 20, content: "unarchived older match" }]
          : [],
      removed: [],
      revision: 2,
      more: false,
    }),
  );
  const result = await feed.load("alice:files", false, page, updates);
  expect(result!.items.map((item) => item.id)).toEqual(["100", "20"]);
  expect(updates).toHaveBeenCalledWith(1, 0);
});

it("advances an unchanged feed watermark without publishing a new snapshot", async () => {
  const feed = new ResultsPager<Card>(),
    page = pageFrom(cards(1));
  await feed.load("alice:all", false, page, noChanges);
  const updates = vi.fn(async (): Promise<ResultsUpdates<Card>> => ({
    items: [],
    removed: ["not-loaded"],
    revision: 7,
    more: false,
  }));
  expect(await feed.load("alice:all", false, page, updates)).toBeNull();
  await feed.load("alice:all", false, page, updates);
  expect(updates).toHaveBeenLastCalledWith(7, 0);
});

it("drains all pages from one notification and applies removals without a catch-up timer", async () => {
  const pager = new ResultsPager<Card>(),
    page = pageFrom(cards(100));
  await pager.load("owner:source", false, page, noChanges);
  let calls = 0;
  const updates = vi.fn(
    async (after: number): Promise<ResultsUpdates<Card>> => {
      calls++;
      return {
        items: [
          {
            id: String(100 - calls),
            cursor: 100 - calls,
            content: "changed " + calls,
          },
        ],
        removed: calls === 3 ? ["100"] : [],
        revision: after + 1,
        more: calls < 4,
      };
    },
  );
  const result = await pager.load("owner:source", false, page, updates);
  expect(updates).toHaveBeenCalledTimes(4);
  expect(result!.items.some((item) => item.id === "100")).toBe(false);
  expect(
    result!.items.filter((item) => item.content.startsWith("changed")),
  ).toHaveLength(4);
  expect(result!.revision).toBe(5);
});
