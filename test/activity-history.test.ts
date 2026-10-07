import { expect, it } from "vitest";
import { ActivityHistory } from "../src/client/activityHistory";
import {
  mergeActivities,
  type ActivityPage,
  type ActivityItem,
} from "../src/client/activityView";

const item = (key: string, sequence: number): ActivityItem => ({
  key,
  sequence,
  kind: "tool",
  run: "run",
  record: { v: 1, kind: "tool", data: { title: key } },
});
const page = (
  cursor: number,
  items: ActivityItem[] = [],
  extra: Partial<ActivityPage> = {},
): ActivityPage => ({
  version: 1,
  items,
  cursor,
  more: false,
  ...extra,
});

it("loads one recent page on open and keeps historical and live cursors independent", async () => {
  const requests: string[] = [];
  const pages = [
    page(200, [item("recent", 200)], { earlier: 101, legacyAvailable: true }),
    page(202, [item("recent", 202)]),
    page(100, [item("recent", 50), item("older", 100)], { earlier: null }),
    page(0, [{ ...item("legacy", 0), legacy: true }], { earlier: null }),
    page(203, [item("new", 203)]),
  ];
  let items: ActivityItem[] = [];
  let state: any;
  const loader = new ActivityHistory(
    "/activities",
    async (url) => {
      requests.push(url);
      return pages.shift()!;
    },
    (p) => {
      items = mergeActivities(items, p);
    },
    (next) => {
      state = next;
    },
  );
  await loader.refresh();
  expect(requests).toEqual(["/activities?view=recent"]);
  expect(state.hasEarlier).toBe(true);
  await loader.refresh();
  await loader.loadEarlier();
  await loader.loadEarlier();
  await loader.refresh();
  expect(requests).toEqual([
    "/activities?view=recent",
    "/activities?view=updates&after=200",
    "/activities?view=recent&before=101",
    `/activities?view=legacy&before=${Number.MAX_SAFE_INTEGER}`,
    "/activities?view=updates&after=202",
  ]);
  expect(items.find((i) => i.key === "recent")!.sequence).toBe(202);
  expect(items.map((i) => i.key)).toEqual(["legacy", "older", "recent", "new"]);
  expect(state).toMatchObject({
    hasEarlier: false,
    loadingEarlier: false,
    error: "",
  });
});

it("fetches file history only for displayed runs and does not advance the live cursor", async () => {
  const requests: string[] = [];
  const pages = [
    page(200, [], { earlier: 100 }),
    page(90, [], { more: true }),
    page(99),
    page(220),
    page(250),
  ];
  const loader = new ActivityHistory(
    "/activities",
    async (url) => {
      requests.push(url);
      return pages.shift()!;
    },
    () => {},
    () => {},
  );
  await loader.refresh();
  await loader.setRuns(["r1", "r1"]);
  await loader.setRuns(["r1", "r2"]);
  await loader.refresh();
  expect(requests).toEqual([
    "/activities?view=recent",
    "/activities?view=files&runs=r1&after=0",
    "/activities?view=files&runs=r1&after=90",
    "/activities?view=files&runs=r2&after=0",
    "/activities?view=updates&after=200",
  ]);
});

it("discards an in-flight old conversation response and coalesces concurrent refreshes", async () => {
  let resolve!: (page: ActivityPage) => void;
  let requests = 0,
    received = 0,
    states = 0;
  const loader = new ActivityHistory(
    "/old",
    () => {
      requests++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    () => {
      received++;
    },
    () => {
      states++;
    },
  );
  const first = loader.refresh();
  const second = loader.refresh();
  expect(second).toBe(first);
  await Promise.resolve();
  loader.stop();
  resolve(page(10, [], { earlier: null }));
  await first;
  await loader.refresh();
  expect({ requests, received, states }).toEqual({
    requests: 1,
    received: 0,
    states: 0,
  });
});

it("retries a failed older-page read with the same cursor", async () => {
  let fail = true;
  const requests: string[] = [];
  let state: any;
  const loader = new ActivityHistory(
    "/activities",
    async (url) => {
      requests.push(url);
      if (url.includes("before=") && fail) {
        fail = false;
        throw new Error("Disconnected");
      }
      return page(10, [], { earlier: url.includes("before=") ? null : 5 });
    },
    () => {},
    (s) => {
      state = s;
    },
  );
  await loader.refresh();
  await loader.loadEarlier();
  expect(state).toMatchObject({
    hasEarlier: true,
    loadingEarlier: false,
    error: "Disconnected",
  });
  await loader.loadEarlier();
  expect(requests.slice(1)).toEqual([
    "/activities?view=recent&before=5",
    "/activities?view=recent&before=5",
  ]);
  expect(state).toMatchObject({ hasEarlier: false, error: "" });
});

it("preserves snapshot paging with older desktops without refetching it for every displayed run", async () => {
  const requests: string[] = [];
  const pages = [page(500, [], { more: true }), page(750)];
  const loader = new ActivityHistory(
    "/old",
    async (url) => {
      requests.push(url);
      return pages.shift()!;
    },
    () => {},
    () => {},
  );
  await loader.refresh();
  await loader.setRuns(["r1", "r2"]);
  expect(requests).toEqual(["/old?view=recent", "/old?view=updates&after=500"]);
});

it("follows a change signalled during a read with one more read", async () => {
  const requests: string[] = [];
  let release!: (page: ActivityPage) => void;
  const loader = new ActivityHistory(
    "/activities",
    (url) => {
      requests.push(url);
      return requests.length === 1
        ? new Promise<ActivityPage>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(page(300));
    },
    () => {},
    () => {},
  );
  const first = loader.refresh();
  await Promise.resolve();
  // A signal arriving mid-read coalesces, then runs once the read finishes.
  expect(loader.refresh()).toBe(first);
  release(page(200, [], { earlier: null }));
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(requests).toEqual([
    "/activities?view=recent",
    "/activities?view=updates&after=200",
  ]);
});
