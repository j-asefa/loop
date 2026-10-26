import { expect, it } from "vitest";
import { feedItemOrder, refreshDonePage, type DoneRefresh } from "../src/client/feed-done-refresh";

const card = (n: number) => ({
  conversation_id: "thread",
  done_card_key: `run:${n}`,
  last_activity_at: n,
  content: `Result ${n}`,
});
type Item = ReturnType<typeof card>;
it("retains distinct replies to the same question across a history refresh", async () => {
  const items = Array.from({ length: 45 }, (_, index) => ({
    conversation_id: "thread", reply_card_key: `reply:${45 - index}`, last_activity_at: 45 - index,
  }));
  const refreshed = await refreshDonePage(async before => ({
    items: before ? items.slice(40) : items.slice(0, 40), next: before ? null : "older",
  }), { items, next: null }, undefined, () => true);
  expect(refreshed.page.items).toEqual(items);
});
const history = (count: number) => Array.from({ length: count }, (_, i) => card(count - i));
function server(items: Item[]) {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    async read(before?: string) {
      calls.push(before);
      const boundary = before ? JSON.parse(before) as Item : undefined;
      const remaining = [...items].sort(feedItemOrder).filter((item) => !boundary || feedItemOrder(item, boundary) > 0);
      const page = remaining.slice(0, 40);
      return { items: page, next: remaining.length > 40 ? JSON.stringify(page.at(-1)) : null, summary: "fresh" };
    },
  };
}

it("bounds every deep-history refresh to two reads while retaining all loaded results", async () => {
  const items = history(2000);
  const api = server(items);
  let previous = { items, next: null as string | null };
  let progress: DoneRefresh | undefined;
  for (let cycle = 0; cycle < 52; cycle++) {
    const before = api.calls.length;
    const result = await refreshDonePage(api.read, previous, progress, () => true);
    expect(api.calls.length - before).toBeLessThanOrEqual(2);
    expect(result.page.items).toEqual(items);
    expect(result.page.next).toBeNull();
    previous = result.page;
    progress = result.progress;
  }
});

it("reconciles remote dismissal and changed content as it reaches older loaded pages", async () => {
  const items = history(125);
  const stored = items.filter((item) => item.last_activity_at !== 12).map((item) =>
    item.last_activity_at === 10 ? { ...item, content: "Updated result" } : item);
  stored.unshift(card(126));
  const api = server(stored);
  let previous = { items, next: null as string | null };
  let progress: DoneRefresh | undefined;
  for (let cycle = 0; cycle < 3; cycle++) {
    const result = await refreshDonePage(api.read, previous, progress, () => true);
    expect(result.page.items.some((item) => item.last_activity_at === 126)).toBe(true);
    expect(result.page.items.some((item) => item.last_activity_at === 1)).toBe(true);
    previous = result.page;
    progress = result.progress;
  }
  expect(previous.items).toEqual(stored);
});

it("prioritizes a new front-page gap and retains its older cached results", async () => {
  const items = history(200);
  const api = server(history(245));
  const progress = { before: JSON.stringify(card(100)), after: card(100) };
  const result = await refreshDonePage(api.read, { items, next: null }, progress, () => true);
  expect(api.calls).toHaveLength(2);
  expect(result.page.items).toEqual(history(245));
});

it("exposes a continuation when a burst of results exceeds the two-page refresh", async () => {
  const api = server(history(200));
  const result = await refreshDonePage(api.read, { items: history(100), next: null }, undefined, () => true);
  expect(api.calls).toHaveLength(2);
  expect(result.page.items).toEqual(expect.arrayContaining(history(100)));
  expect(result.page.next).not.toBeNull();
  const more = await api.read(result.page.next!);
  const combined = new Map([...result.page.items, ...more.items].map((item) => [item.done_card_key, item]));
  expect([...combined.values()].sort(feedItemOrder)).toEqual(history(200));
});

it("keeps a new first page intact when remote removals shrink the loaded window", async () => {
  const items = history(200).slice(0, 120);
  const progress = { before: JSON.stringify(card(121)), after: card(121) };
  const api = server(history(100));
  const result = await refreshDonePage(api.read, { items, next: JSON.stringify(card(81)) }, progress, () => true);
  expect(result.page.items).toEqual(history(100).slice(0, 40));
  expect(api.calls).toHaveLength(1);
  expect((await api.read(result.page.next!)).items[0]).toEqual(card(60));
});

it("keeps equal-time results from different conversations and independent card identities", async () => {
  const items = history(125).map((item, i) => ({ ...item, conversation_id: `thread-${i % 3}`, last_activity_at: 1 })).sort(feedItemOrder);
  const stored = items.filter((_, i) => i !== 50);
  const result = await refreshDonePage(server(stored).read, { items, next: null }, undefined, () => true);
  expect(result.page.items).toEqual(stored);
});

it("does not silently prefetch history beyond the loaded window", async () => {
  const items = history(200);
  const previous = { items: items.slice(0, 95), next: JSON.stringify(items[94]) };
  let result = await refreshDonePage(server(items).read, previous, undefined, () => true);
  result = await refreshDonePage(server(items).read, result.page, result.progress, () => true);
  expect(result.page.items).toEqual(previous.items);
  expect(result.page.next).toBe(previous.next);
});

it("makes newly imported older history reachable after a formerly exhausted window", async () => {
  const items = history(85);
  const api = server([...items, card(0), card(-1)]);
  let result = await refreshDonePage(api.read, { items, next: null }, undefined, () => true);
  result = await refreshDonePage(api.read, result.page, result.progress, () => true);
  expect(result.page.items).toEqual(items);
  expect(result.page.next).not.toBeNull();
  const more = await api.read(result.page.next!);
  expect(more.items).toContainEqual(card(-1));
});

it.each([39, 40])("exposes older imports when the newest page reaches a %i-card exhausted window", async (count) => {
  const items = history(count);
  const api = server([...items, card(0), card(-1)]);
  const result = await refreshDonePage(api.read, { items, next: null }, undefined, () => true);
  expect(api.calls).toHaveLength(1);
  expect(result.page.items).toEqual(expect.arrayContaining(items));
  expect(result.page.next).not.toBeNull();
  expect((await api.read(result.page.next!)).items).toContainEqual(card(-1));
});

it("leaves the source's retained window and progress intact when a history read fails", async () => {
  const items = history(125), original = structuredClone(items);
  const progress = { before: JSON.stringify(card(85)), after: card(85) };
  const originalProgress = structuredClone(progress);
  const read = async (before?: string) => {
    if (before) throw new Error("Source unavailable");
    return server(items).read();
  };
  await expect(refreshDonePage(read, { items, next: null }, progress, () => true)).rejects.toThrow("Source unavailable");
  expect(items).toEqual(original);
  expect(progress).toEqual(originalProgress);
});

it("stops history reads when the owner or selection has changed", async () => {
  const api = server(history(125));
  await refreshDonePage(api.read, { items: history(125), next: null }, undefined, () => false);
  expect(api.calls).toEqual([undefined]);
});
