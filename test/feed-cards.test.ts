import { expect, it, vi } from "vitest";
import { DoneCardsReader } from "../src/client/feed-cards";
import { CardEntrySchema } from "../src/shared/cards";

const entry = (id: string, at: number) =>
  CardEntrySchema.parse({
    card: {
      type: "done",
      id: "d:message:" + id,
      display: {
        conversation_id: id,
        done_card_key: "message:" + id,
        title: id,
        agent_id: null,
        connection_id: null,
        agent_name: null,
        provider: null,
        project_id: null,
        project_name: null,
        team_id: null,
        origin: "import",
        last_activity_at: at,
        last_message: {
          id,
          role: "assistant",
          preview: id,
          content: id,
          created_at: at,
          saved: false,
        },
        run: null,
        pull: null,
        position_message_id: null,
        later: null,
        next_action: null,
      },
      content: id,
      format: "markdown",
      created_at: at,
      updated_at: null,
      saved: false,
      attachments: [],
      href: "/",
      author: { kind: "unknown", id: null, name: null, provider: null },
      recipient: null,
      source: {
        artifact_id: null,
        message_id: id,
        conversation_id: id,
        run_id: null,
      },
      context: {
        conversation_title: id,
        folder_id: null,
        project_id: null,
        project_name: null,
        team_id: null,
      },
    },
    order: [at, id],
    saved: null,
  });
const selection = { view: "done" as const };
const failure = (status: number) =>
  Object.assign(new Error("Unavailable"), { status });

it("falls back only on an unsupported first page and keeps outage failures visible", async () => {
  for (const status of [400, 404]) {
    const reader = new DoneCardsReader("owner/source");
    const transport = vi.fn().mockRejectedValue(failure(status));
    expect(await reader.load(transport, selection, false)).toBeNull();
    expect(await reader.load(transport, selection, false)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  }
  for (const status of [401, 403, 429, 500, 503]) {
    const reader = new DoneCardsReader("owner/source");
    await expect(
      reader.load(
        async () => {
          throw failure(status);
        },
        selection,
        false,
      ),
    ).rejects.toMatchObject({ status });
  }
});

it("retains two nonempty source windows through outage, append and recovery", async () => {
  const a = new DoneCardsReader("owner/a"),
    b = new DoneCardsReader("owner/b");
  let outage = false,
    delta = false;
  const transport = (source: string) => async (path: string) => {
    if (outage && source === "b") throw failure(503);
    if (path.includes("/changes?"))
      return {
        revision: "r2",
        items: delta ? [entry(source + "new", 200)] : [],
        removed: [],
        more: false,
      };
    return {
      revision: "r1",
      items: [
        entry(
          source + (path.includes("before=") ? "old" : "first"),
          path.includes("before=") ? 10 : 100,
        ),
      ],
      next: path.includes("before=") ? null : "older",
    };
  };
  await a.load(transport("a"), selection, false);
  await b.load(transport("b"), selection, false);
  outage = true;
  delta = true;
  await a.load(transport("a"), selection, false);
  await expect(b.load(transport("b"), selection, true)).rejects.toMatchObject({
    status: 503,
  });
  expect(b.pager.snapshot()!.page.items.map((e) => e.card.id)).toEqual([
    "d:message:bfirst",
  ]);
  expect(b.pager.snapshot()!.page.next).toBe("older");
  outage = false;
  await b.load(transport("b"), selection, true);
  expect(b.pager.snapshot()!.page.items.map((e) => e.card.id)).toEqual([
    "d:message:bnew",
    "d:message:bfirst",
    "d:message:bold",
  ]);
  const restored = new DoneCardsReader("owner/b", b.pager.snapshot()!);
  const requests: string[] = [];
  await restored.load(
    async (path) => {
      requests.push(path);
      return transport("b")(path);
    },
    selection,
    false,
  );
  expect(requests.every((path) => path.includes("/changes?"))).toBe(true);
  await expect(
    restored.load(
      async () => {
        throw failure(400);
      },
      selection,
      true,
    ),
  ).resolves.toBeNull();
});

it("re-probes an upgraded source and distinguishes invalid cursors from lost capability", async () => {
  const reader = new DoneCardsReader("owner/source");
  expect(
    await reader.load(
      async () => {
        throw failure(400);
      },
      selection,
      false,
    ),
  ).toBeNull();
  const request = async (path: string) =>
    path.includes("/changes?")
      ? { revision: "new", items: [], removed: [], more: false }
      : { revision: "old", items: [entry("upgraded", 1)], next: "older" };
  expect(
    (await reader.load(request, selection, false))!.page.items[0].card.id,
  ).toBe("d:message:upgraded");
  await expect(
    reader.load(
      async (path) => {
        if (path.includes("before=")) throw failure(400);
        return request(path);
      },
      selection,
      true,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(reader.pager.snapshot()!.page.items).toHaveLength(1);
  expect(
    await reader.load(
      async () => {
        throw failure(404);
      },
      selection,
      false,
    ),
  ).toBeNull();
  expect(
    (await reader.load(request, selection, false))!.page.items,
  ).toHaveLength(1);
});

it("restarts once after a 409 revision reset without misclassifying it as an outage", async () => {
  const reader = new DoneCardsReader("owner/reset");
  let revisionExpired = false,
    pageReads = 0;
  const request = async (path: string) => {
    if (path.includes("/changes?")) {
      if (revisionExpired) {
        revisionExpired = false;
        throw failure(409);
      }
      return { revision: "current", items: [], removed: [], more: false };
    }
    pageReads++;
    return { revision: "first", items: [entry("kept", 100)], next: "older" };
  };
  await reader.load(request, selection, false);
  revisionExpired = true;
  expect(
    (await reader.load(request, selection, false))!.page.items[0].card.id,
  ).toBe("d:message:kept");
  expect(pageReads).toBe(2);
  await expect(
    reader.load(
      async (path) => {
        if (path.includes("/changes?")) throw failure(409);
        return request(path);
      },
      selection,
      false,
    ),
  ).rejects.toMatchObject({ status: 409 });
});

it("replays pending Load more after an optimistic action invalidates its response", async () => {
  const reader = new DoneCardsReader("owner/action");
  const delta = { revision: "r", items: [], removed: [], more: false };
  await reader.load(
    async (path) =>
      path.includes("/changes?")
        ? delta
        : { revision: "r", items: [entry("first", 100)], next: "older" },
    selection,
    false,
  );
  let release!: (page: unknown) => void;
  const active = reader.load(
    async (path) =>
      path.includes("/changes?")
        ? delta
        : new Promise((resolve) => {
            release = resolve;
          }),
    selection,
    true,
  );
  const saved = reader.pager.snapshot()!;
  reader.invalidateForAction();
  reader.pager.restore(reader.key, saved);
  release({ revision: "r", items: [entry("old", 10)], next: null });
  await active;
  const paths: string[] = [];
  const result = await reader.load(
    async (path) => {
      paths.push(path);
      return path.includes("/changes?")
        ? delta
        : { revision: "r", items: [entry("old", 10)], next: null };
    },
    selection,
    false,
  );
  expect(paths[0]).toContain("before=older");
  expect(result!.page.items.map((item) => item.card.id)).toEqual([
    "d:message:first",
    "d:message:old",
  ]);
});

it("keeps concurrent callers on Cards while an expired revision resets the pager", async () => {
  const reader = new DoneCardsReader("owner/concurrent-reset");
  const delta = { revision: "r", items: [], removed: [], more: false };
  const page = { revision: "r", items: [entry("kept", 100)], next: null };
  await reader.load(
    async (path) => (path.includes("/changes?") ? delta : page),
    selection,
    false,
  );
  let reject!: (error: unknown) => void;
  let expire = true;
  const request = async (path: string) => {
    if (!path.includes("/changes?")) return page;
    if (expire) {
      expire = false;
      return new Promise((_, fail) => {
        reject = fail;
      });
    }
    return delta;
  };
  const first = reader.load(request, selection, false);
  const second = reader.load(request, selection, true);
  reject(failure(409));
  const windows = await Promise.all([first, second]);
  expect(
    windows.every(
      (window) => window?.page.items[0].card.id === "d:message:kept",
    ),
  ).toBe(true);
});
