import { feedItemOrder } from "../src/shared/feed-order";
import { expect, it } from "vitest";
import {
  refreshDonePage,
  type DoneRefresh,
} from "../src/client/feed-done-refresh";

const card = (n: number) => ({
  conversation_id: "thread",
  done_card_key: `run:${n}`,
  last_activity_at: n,
  content: `Result ${n}`,
});
type Item = ReturnType<typeof card>;
it("retains distinct replies to the same question across a history refresh", async () => {
  const items = Array.from({ length: 45 }, (_, index) => ({
    conversation_id: "thread",
    reply_card_key: `reply:${45 - index}`,
    last_activity_at: 45 - index,
  }));
  const refreshed = await refreshDonePage(
    async (before) => ({
      items: before ? items.slice(40) : items.slice(0, 40),
      next: before ? null : "older",
    }),
    { items, next: null },
    undefined,
    () => true,
  );
  expect(refreshed.page.items).toEqual(items);
});
const history = (count: number) =>
  Array.from({ length: count }, (_, i) => card(count - i));
function server(items: Item[]) {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    async read(before?: string) {
      calls.push(before);
      const boundary = before ? (JSON.parse(before) as Item) : undefined;
      const remaining = [...items]
        .sort(feedItemOrder)
        .filter((item) => !boundary || feedItemOrder(item, boundary) > 0);
      const page = remaining.slice(0, 40);
      return {
        items: page,
        next: remaining.length > 40 ? JSON.stringify(page.at(-1)) : null,
        summary: "fresh",
      };
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
    const result = await refreshDonePage(
      api.read,
      previous,
      progress,
      () => true,
    );
    expect(api.calls.length - before).toBeLessThanOrEqual(2);
    expect(result.page.items).toEqual(items);
    expect(result.page.next).toBeNull();
    previous = result.page;
    progress = result.progress;
  }
});

it("reconciles remote dismissal and changed content as it reaches older loaded pages", async () => {
  const items = history(125);
  const stored = items
    .filter((item) => item.last_activity_at !== 12)
    .map((item) =>
      item.last_activity_at === 10
        ? { ...item, content: "Updated result" }
        : item,
    );
  stored.unshift(card(126));
  const api = server(stored);
  let previous = { items, next: null as string | null };
  let progress: DoneRefresh | undefined;
  for (let cycle = 0; cycle < 3; cycle++) {
    const result = await refreshDonePage(
      api.read,
      previous,
      progress,
      () => true,
    );
    expect(
      result.page.items.some((item) => item.last_activity_at === 126),
    ).toBe(true);
    expect(result.page.items.some((item) => item.last_activity_at === 1)).toBe(
      true,
    );
    previous = result.page;
    progress = result.progress;
  }
  expect(previous.items).toEqual(stored);
});

it("prioritizes a new front-page gap and retains its older cached results", async () => {
  const items = history(200);
  const api = server(history(245));
  const progress = { before: JSON.stringify(card(100)), after: card(100) };
  const result = await refreshDonePage(
    api.read,
    { items, next: null },
    progress,
    () => true,
  );
  expect(api.calls).toHaveLength(2);
  expect(result.page.items).toEqual(history(245));
});

it("exposes a continuation when a burst of results exceeds the two-page refresh", async () => {
  const api = server(history(200));
  const result = await refreshDonePage(
    api.read,
    { items: history(100), next: null },
    undefined,
    () => true,
  );
  expect(api.calls).toHaveLength(2);
  expect(result.page.items).toEqual(expect.arrayContaining(history(100)));
  expect(result.page.next).not.toBeNull();
  const more = await api.read(result.page.next!);
  const combined = new Map(
    [...result.page.items, ...more.items].map((item) => [
      item.done_card_key,
      item,
    ]),
  );
  expect([...combined.values()].sort(feedItemOrder)).toEqual(history(200));
});

it("keeps a new first page intact when remote removals shrink the loaded window", async () => {
  const items = history(200).slice(0, 120);
  const progress = { before: JSON.stringify(card(121)), after: card(121) };
  const api = server(history(100));
  const result = await refreshDonePage(
    api.read,
    { items, next: JSON.stringify(card(81)) },
    progress,
    () => true,
  );
  expect(result.page.items).toEqual(history(100).slice(0, 40));
  expect(api.calls).toHaveLength(1);
  expect((await api.read(result.page.next!)).items[0]).toEqual(card(60));
});

it.each([false, true])(
  "restores the loaded-window continuation after a large gap (second pull: %s)",
  async (secondPull) => {
    const loaded = history(100).slice(0, 95);
    const continuation = JSON.stringify(loaded.at(-1));
    const api = server(history(225));
    let previous = { items: loaded, next: continuation as string | null };
    let progress: DoneRefresh | undefined;
    for (let cycle = 0; cycle < 8; cycle++) {
      const result = await refreshDonePage(
        api.read,
        previous,
        progress,
        () => true,
      );
      previous = result.page;
      progress = result.progress;
      if (secondPull && cycle === 0 && progress)
        progress = { ...progress, restart: true };
      if (!progress) break;
    }
    expect(progress).toBeUndefined();
    expect(previous.next).toBe(continuation);
    expect(previous.items).toEqual(history(225).slice(0, 220));
    expect((await api.read(previous.next!)).items).toEqual(history(5));
  },
);

it("rejects non-advancing history before it can schedule a reconciliation loop", async () => {
  const items = history(125);
  const api = server(items);
  const first = await api.read();
  const read = async (before?: string) =>
    before ? { ...first, next: before } : first;
  await expect(
    refreshDonePage(read, { items, next: null }, undefined, () => true),
  ).rejects.toThrow("History pagination did not advance");
  expect(items).toEqual(history(125));
});

it("keeps equal-time results from different conversations and independent card identities", async () => {
  const items = history(125)
    .map((item, i) => ({
      ...item,
      conversation_id: `thread-${i % 3}`,
      last_activity_at: 1,
    }))
    .sort(feedItemOrder);
  const stored = items.filter((_, i) => i !== 50);
  const result = await refreshDonePage(
    server(stored).read,
    { items, next: null },
    undefined,
    () => true,
  );
  expect(result.page.items).toEqual(stored);
});

it("does not silently prefetch history beyond the loaded window", async () => {
  const items = history(200);
  const previous = {
    items: items.slice(0, 95),
    next: JSON.stringify(items[94]),
  };
  let result = await refreshDonePage(
    server(items).read,
    previous,
    undefined,
    () => true,
  );
  result = await refreshDonePage(
    server(items).read,
    result.page,
    result.progress,
    () => true,
  );
  expect(result.page.items).toEqual(previous.items);
  expect(result.page.next).toBe(previous.next);
});

it("makes newly imported older history reachable after a formerly exhausted window", async () => {
  const items = history(85);
  const api = server([...items, card(0), card(-1)]);
  let result = await refreshDonePage(
    api.read,
    { items, next: null },
    undefined,
    () => true,
  );
  result = await refreshDonePage(
    api.read,
    result.page,
    result.progress,
    () => true,
  );
  expect(result.page.items).toEqual(items);
  expect(result.page.next).not.toBeNull();
  const more = await api.read(result.page.next!);
  expect(more.items).toContainEqual(card(-1));
});

it.each([39, 40])(
  "exposes older imports when the newest page reaches a %i-card exhausted window",
  async (count) => {
    const items = history(count);
    const api = server([...items, card(0), card(-1)]);
    const result = await refreshDonePage(
      api.read,
      { items, next: null },
      undefined,
      () => true,
    );
    expect(api.calls).toHaveLength(1);
    expect(result.page.items).toEqual(expect.arrayContaining(items));
    expect(result.page.next).not.toBeNull();
    expect((await api.read(result.page.next!)).items).toContainEqual(card(-1));
  },
);

it("returns a successful head with retained history and an explicit history error", async () => {
  const items = history(125),
    original = structuredClone(items);
  const progress = { before: JSON.stringify(card(85)), after: card(85) };
  const originalProgress = structuredClone(progress);
  const read = async (before?: string) => {
    if (before) throw new Error("Source unavailable");
    return server([card(126), ...items]).read();
  };
  const result = await refreshDonePage(
    read,
    { items, next: null },
    progress,
    () => true,
  );
  expect(result.error?.message).toBe("Source unavailable");
  expect(result.page.items).toContainEqual(card(126));
  expect(result.page.items).toContainEqual(card(1));
  expect(result.progress?.before).toBe(progress.before);
  expect(items).toEqual(original);
  expect(progress).toEqual(originalProgress);
});

it("stops history reads when the owner or selection has changed", async () => {
  const api = server(history(125));
  await refreshDonePage(
    api.read,
    { items: history(125), next: null },
    undefined,
    () => false,
  );
  expect(api.calls).toEqual([undefined]);
});

it("revisits a newly uncovered interval when live updates move the head", async () => {
  const initial = history(200);
  let result = await refreshDonePage(
    server(initial).read,
    { items: initial, next: null },
    undefined,
    () => true,
  );
  const changed = history(210).filter((item) => item.last_activity_at !== 160);
  for (let cycle = 0; cycle < 8; cycle++) {
    result = await refreshDonePage(
      server(changed).read,
      result.page,
      result.progress,
      () => true,
    );
    if (!result.progress) break;
  }
  expect(result.progress).toBeUndefined();
  expect(result.page.items).toEqual(changed);
});

it("preserves the real continuation when the oldest loaded row moves to the head", async () => {
  const loaded = history(100).slice(0, 95);
  const continuation = JSON.stringify(loaded.at(-1));
  let result = await refreshDonePage(
    server(history(225)).read,
    { items: loaded, next: continuation },
    undefined,
    () => true,
  );
  const moved = { ...card(6), last_activity_at: 226 };
  const changed = [
    moved,
    ...history(225).filter((item) => item.last_activity_at !== 6),
  ];
  for (let cycle = 0; cycle < 10; cycle++) {
    result = await refreshDonePage(
      server(changed).read,
      result.page,
      result.progress,
      () => true,
    );
    if (!result.progress) break;
  }
  expect(result.progress).toBeUndefined();
  expect(result.page.next).toBe(continuation);
  expect((await server(changed).read(result.page.next!)).items).toEqual(
    history(5),
  );
});

it("revisits a completed interval after a notification without a moving head", async () => {
  const initial = history(200);
  let result = await refreshDonePage(
    server(initial).read,
    { items: initial, next: null },
    undefined,
    () => true,
  );
  result.progress!.rescan = true;
  const changed = initial.filter((item) => item.last_activity_at !== 160);
  for (let cycle = 0; cycle < 12; cycle++) {
    result = await refreshDonePage(
      server(changed).read,
      result.page,
      result.progress,
      () => true,
    );
    if (!result.progress) break;
  }
  expect(result.page.items).toEqual(changed);
  expect(result.progress).toBeUndefined();
});

it("reaches old removals even when every pass moves the head", async () => {
  const initial = history(400);
  let result = await refreshDonePage(
    server(initial).read,
    { items: initial, next: null },
    undefined,
    () => true,
  );
  for (let cycle = 1; cycle <= 12; cycle++) {
    const changed = history(400 + cycle).filter(
      (item) => item.last_activity_at !== 10,
    );
    result = await refreshDonePage(
      server(changed).read,
      result.page,
      result.progress,
      () => true,
    );
  }
  expect(result.page.items.some((item) => item.last_activity_at === 10)).toBe(
    false,
  );
});

it("keeps an exposed gap reachable across repeated history failures", async () => {
  const api = server(history(225));
  const read = async (before?: string) => {
    if (before) throw new Error("history unavailable");
    return api.read();
  };
  const initial = {
    items: history(100).slice(0, 95),
    next: JSON.stringify(card(6)),
  };
  let result = await refreshDonePage(read, initial, undefined, () => true);
  const gap = result.page.next;
  for (let i = 0; i < 3; i++)
    result = await refreshDonePage(
      read,
      result.page,
      result.progress,
      () => true,
    );
  expect(result.page.next).toBe(gap);
  expect((await api.read(gap!)).items[0]).toEqual(card(185));
  expect(result.error?.message).toBe("history unavailable");
});

it("a newer failed pull exposes its new gap ahead of an earlier failed gap", async () => {
  let items = history(225);
  const read = async (before?: string) => {
    if (before) throw new Error("history unavailable");
    return server(items).read();
  };
  const initial = {
    items: history(100).slice(0, 95),
    next: JSON.stringify(card(6)),
  };
  let result = await refreshDonePage(read, initial, undefined, () => true);
  items = history(300);
  result = await refreshDonePage(
    read,
    result.page,
    { ...result.progress!, restart: true },
    () => true,
  );
  expect((await server(items).read(result.page.next!)).items[0]).toEqual(
    card(260),
  );
});

it("keeps a gap reachable after an intermediate success and a later failure", async () => {
  const api = server(history(400));
  let result = await refreshDonePage(
    api.read,
    { items: history(100), next: null },
    undefined,
    () => true,
  );
  result = await refreshDonePage(
    api.read,
    result.page,
    result.progress,
    () => true,
  );
  const gap = result.page.next;
  expect(gap).not.toBeNull();
  const read = async (before?: string) => {
    if (before) throw new Error("history unavailable");
    return api.read();
  };
  result = await refreshDonePage(
    read,
    result.page,
    result.progress,
    () => true,
  );
  expect(result.page.next).toBe(gap);
  expect((await api.read(result.page.next!)).items[0]).toEqual(card(280));
});

it("finishes a new burst above an already active history sweep", async () => {
  const original = history(200);
  let result = await refreshDonePage(
    server(original).read,
    { items: original, next: null },
    undefined,
    () => true,
  );
  result = await refreshDonePage(
    server(original).read,
    result.page,
    result.progress,
    () => true,
  );
  const changed = history(300);
  for (let cycle = 0; cycle < 15; cycle++) {
    result = await refreshDonePage(
      server(changed).read,
      result.page,
      result.progress,
      () => true,
    );
    if (!result.progress) break;
  }
  expect(result.progress).toBeUndefined();
  expect(result.page.items).toEqual(changed);
});
