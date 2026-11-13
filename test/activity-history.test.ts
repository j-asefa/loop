import { ActivityKey } from "../src/shared/contract-ids.js";
import { ConversationId } from "../src/shared/contract-ids.js";
import { expect, it } from "vitest";
import { workspaceApi } from "../src/shared/workspace-api";
import { routePath } from "../src/shared/route-path";
import {
  ActivityRecordSchema,
  reduceActivity,
} from "../src/shared/agent-activities";
import { ActivityHistory } from "../src/client/activityHistory";
import {
  mergeActivities,
  type ActivityPage,
  type ActivityItem,
} from "../src/client/activityView";

const item = (key: string, sequence: number): ActivityItem => ({
  key: ActivityKey.parse(key),
  sequence,
  kind: "tool",
  run: "run",
  record: ActivityRecordSchema.parse(
    reduceActivity(undefined, {
      v: 1,
      kind: "tool",
      id: key,
      source: { transport: "api", origin: "test" },
      patch: { title: key },
    }).record!,
  ),
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
    page(200, [item("recent", 200)], { earlier: 101 }),
    page(202, [item("recent", 202)]),
    page(100, [item("recent", 50), item("older", 100)], { earlier: null }),
    page(203, [item("new", 203)]),
  ];
  let items: ActivityItem[] = [];
  let state: any;
  const loader = new ActivityHistory(
    async (query) => {
      const url = routePath(workspaceApi.conversationActivities, {
        params: { id: ConversationId.parse("thread") },
        query,
      });
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
  expect(requests).toEqual(["/conversations/thread/activities?view=recent"]);
  expect(state.hasEarlier).toBe(true);
  await loader.refresh();
  await loader.loadEarlier();
  await loader.loadEarlier();
  await loader.refresh();
  expect(requests).toEqual([
    "/conversations/thread/activities?view=recent",
    "/conversations/thread/activities?view=updates&after=200",
    "/conversations/thread/activities?view=recent&before=101",
    "/conversations/thread/activities?view=updates&after=202",
  ]);
  expect(items.find((i) => i.key === "recent")!.sequence).toBe(202);
  expect(items.map((i) => i.key)).toEqual(["older", "recent", "new"]);
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
    async (query) => {
      const url = routePath(workspaceApi.conversationActivities, {
        params: { id: ConversationId.parse("thread") },
        query,
      });
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
    "/conversations/thread/activities?view=recent",
    "/conversations/thread/activities?view=files&runs=r1&after=0",
    "/conversations/thread/activities?view=files&runs=r1&after=90",
    "/conversations/thread/activities?view=files&runs=r2&after=0",
    "/conversations/thread/activities?view=updates&after=200",
  ]);
});

it("discards an in-flight old conversation response and coalesces concurrent refreshes", async () => {
  let resolve!: (page: ActivityPage) => void;
  let requests = 0,
    received = 0,
    states = 0;
  const loader = new ActivityHistory(
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
  const modes: string[] = [];
  let state: any;
  const loader = new ActivityHistory(
    async (query, mode) => {
      modes.push(mode);
      const url = routePath(workspaceApi.conversationActivities, {
        params: { id: ConversationId.parse("thread") },
        query,
      });
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
  await loader.setRuns([]);
  expect(state.error).toBe("Disconnected");
  await loader.setRuns(["new-run"]);
  expect(state.error).toBe("Disconnected");
  await loader.refresh();
  expect(state.error).toBe("Disconnected");
  await loader.retry();
  expect(requests.slice(1)).toEqual([
    "/conversations/thread/activities?view=recent&before=5",
    "/conversations/thread/activities?view=files&runs=new-run&after=0",
    "/conversations/thread/activities?view=updates&after=10",
    "/conversations/thread/activities?view=recent&before=5",
  ]);
  expect(modes).toEqual([
    "automatic",
    "automatic",
    "automatic",
    "automatic",
    "manual",
  ]);
  expect(state).toMatchObject({ hasEarlier: false, error: "" });
});

it("retains separate failed operations and coalesces repeated manual retries", async () => {
  const requests: { query: unknown; mode: string }[] = [];
  let failEarlier = true,
    failFiles = true;
  let state: any;
  const loader = new ActivityHistory(
    async (query, mode) => {
      requests.push({ query, mode });
      if (query?.before && failEarlier) throw new Error("Earlier unavailable");
      if (query?.view === "files" && failFiles)
        throw new Error("Files unavailable");
      return page(10, [], { earlier: query?.before ? null : 5 });
    },
    () => {},
    (next) => {
      state = next;
    },
  );
  await loader.refresh();
  await loader.loadEarlier();
  await loader.setRuns(["run"]);
  expect(state.error).toBe("Earlier unavailable");
  failEarlier = false;
  const retry = loader.retry();
  expect(state.loading).toBe(true);
  expect(loader.retry()).toBe(retry);
  await retry;
  expect(state).toMatchObject({
    hasEarlier: false,
    error: "Files unavailable",
  });
  failFiles = false;
  await loader.retry();
  expect(requests.slice(3)).toEqual([
    { query: { view: "recent", before: "5" }, mode: "manual" },
    { query: { view: "files", runs: "run", after: "0" }, mode: "manual" },
  ]);
  expect(state).toMatchObject({ loading: false, error: "" });
});

it("follows a change signalled during a read with one more read", async () => {
  const requests: string[] = [];
  let release!: (page: ActivityPage) => void;
  const loader = new ActivityHistory(
    (query) => {
      const url = routePath(workspaceApi.conversationActivities, {
        params: { id: ConversationId.parse("thread") },
        query,
      });
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
    "/conversations/thread/activities?view=recent",
    "/conversations/thread/activities?view=updates&after=200",
  ]);
});

it("keeps exhausted errors visible while fallback reads run and ignores ticks during an active read", async () => {
  let reads = 0;
  let release!: (value: ActivityPage) => void;
  let state = { error: "", loading: false };
  const loader = new ActivityHistory(
    async () => {
      if (++reads === 1) throw new Error("Offline");
      return new Promise<ActivityPage>((resolve) => {
        release = resolve;
      });
    },
    () => {},
    (next) => {
      state = next;
    },
  );
  await loader.refresh();
  expect(state.error).toBe("Offline");
  const pending = loader.refresh(false, true);
  await Promise.resolve();
  expect(state).toMatchObject({ error: "Offline", loading: true });
  expect(loader.refresh(false, true)).toBe(pending);
  expect(reads).toBe(2);
  release(page(200, [], { earlier: null }));
  await pending;
  await Promise.resolve();
  expect(reads).toBe(2);
  expect(state).toMatchObject({ error: "", loading: false });
});

it("loads conversation controls and displayed files without requesting tool history", async () => {
  const requests: string[] = [];
  const loader = new ActivityHistory(
    async (query) => {
      const url = routePath(workspaceApi.conversationActivities, {
        params: { id: ConversationId.parse("thread") },
        query,
      });
      requests.push(url);
      return page(200, [], { earlier: null });
    },
    () => {},
    () => {},
    false,
  );
  await loader.refresh();
  await loader.setRuns(["run"]);
  await loader.refresh();
  await loader.loadEarlier();
  expect(requests).toEqual([
    "/conversations/thread/activities?view=recent&tools=0",
    "/conversations/thread/activities?view=files&runs=run&after=0",
    "/conversations/thread/activities?view=updates&tools=0&after=200",
  ]);
});
