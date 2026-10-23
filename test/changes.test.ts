import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChangeBus, type CommittedEvent } from "../src/server/changes";

let directory: string;
let local: typeof import("../src/server/db");
let foreign: Database.Database;
beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "loop-changes-"));
  vi.stubEnv("LOOP_DATA_DIR", directory);
  // Ordering tests must finish before a foreign-commit poll could help them.
  vi.stubEnv("LOOP_CHANGE_POLL_MS", "60000");
  local = await import("../src/server/db");
  foreign = new Database(join(directory, "loop.db"));
  foreign.pragma("journal_mode = WAL");
  for (const owner of ["one", "two"])
    local.db
      .prepare(
        "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,'fixture','running',?,1,1)",
      )
      .run(owner, owner, owner);
  // Test bus ordering after the fixture snapshot, independent of the expiry
  // scheduler's own subscription and the newly covered run-insert events.
  local.deadlines.close();
  local.changes.wake();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
afterEach(() => {
  vi.restoreAllMocks();
  local.changes.close();
  foreign.close();
  local.db.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const insertForeign = (owner: string, type: string) =>
  Number(
    foreign
      .prepare(
        "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,?,?,'{}',1)",
      )
      .run(owner, owner, type).lastInsertRowid,
  );
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

it("reads a lower foreign id before a local commit and partitions owner delivery", async () => {
  const all: CommittedEvent[] = [],
    one: CommittedEvent[] = [],
    two: CommittedEvent[] = [];
  local.changes.subscribe(null, (rows) => all.push(...rows));
  local.changes.subscribe("one", (rows) => one.push(...rows));
  local.changes.subscribe("two", (rows) => two.push(...rows));
  const first = insertForeign("one", "foreign");
  const second = Number(local.emit("two", "two", "queued", {}));
  const third = Number(local.emit("one", "one", "running", {}));
  await expect.poll(() => all.length).toBe(3);
  expect(all.map((row) => row.id)).toEqual([first, second, third]);
  expect(one.map((row) => row.id)).toEqual([first, third]);
  expect(two.map((row) => row.id)).toEqual([second]);
});

it.each(["default", "deferred", "immediate", "exclusive"] as const)(
  "publishes only committed rows after caught savepoint and outer rollbacks (%s)",
  async (mode) => {
    const seen: string[] = [],
      inTransaction: boolean[] = [];
    local.changes.subscribe("one", (rows) => {
      seen.push(...rows.map((row) => row.type));
      inTransaction.push(local.db.inTransaction);
    });
    const invoke = (fn: () => void) => {
      const transaction = local.db.transaction(fn);
      return mode === "default" ? transaction() : transaction[mode]();
    };
    invoke(() => {
      local.emit("one", "one", "queued", {});
      try {
        invoke(() => {
          local.emit("one", "one", "failed", {});
          throw new Error("savepoint rollback");
        });
      } catch {}
      local.emit("one", "one", "running", {});
      expect(seen).toEqual([]);
    });
    expect(() =>
      invoke(() => {
        local.emit("one", "one", "cancelled", {});
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    await expect.poll(() => seen.length).toBe(2);
    expect(seen).toEqual(["queued", "running"]);
    expect(inTransaction).toEqual([false]);
  },
);

it("isolates throwing and reentrant subscribers without overtaking committed rows", async () => {
  const seen: string[] = [];
  local.changes.subscribe("one", () => {
    throw new Error("subscriber failed");
  });
  local.changes.subscribe("one", async () => {
    throw new Error("async subscriber failed");
  });
  local.changes.subscribe("one", (rows) => {
    if (rows.some((row) => row.type === "queued"))
      local.emit("one", "one", "completed", {});
  });
  local.changes.subscribe("one", (rows) =>
    seen.push(...rows.map((row) => row.type)),
  );
  expect(() =>
    local.db
      .transaction(() => {
        local.emit("one", "one", "queued", {});
        local.emit("one", "one", "running", {});
      })
      .immediate(),
  ).not.toThrow();
  await expect.poll(() => seen.length).toBe(3);
  expect(seen).toEqual(["queued", "running", "completed"]);
});

it("publishes nothing when SQLite rejects the outer commit", async () => {
  const seen: string[] = [];
  local.changes.subscribe("one", (rows) =>
    seen.push(...rows.map((row) => row.type)),
  );
  expect(() =>
    local.db
      .transaction(() => {
        local.db.pragma("defer_foreign_keys = ON");
        local.emit("one", "one", "queued", {});
        local.db.prepare("INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES('one','missing-run','running','{}',1)").run();
      })
      .immediate(),
  ).toThrow(/FOREIGN KEY/);
  await turn();
  expect(seen).toEqual([]);
  local.emit("one", "one", "completed", {});
  await expect.poll(() => seen).toEqual(["completed"]);
});

it("drains all bounded pages without another write and accepts subscriptions during catch-up", async () => {
  const seen: number[] = [],
    late: number[] = [];
  let firstPage: number[] | undefined;
  local.changes.subscribe("one", (rows) => {
    seen.push(...rows.map((row) => row.id));
    if (!firstPage) {
      firstPage = rows.map((row) => row.id);
      local.changes.subscribe("one", (next) =>
        late.push(...next.map((row) => row.id)),
      );
    }
  });
  const ids: number[] = [];
  local.db
    .transaction(() => {
      for (let n = 0; n < 700; n++)
        ids.push(Number(local.emit("one", "one", "queued", {})));
    })
    .immediate();
  await expect.poll(() => seen.length).toBe(700);
  expect(seen).toEqual(ids);
  expect(firstPage!.length).toBeLessThan(ids.length);
  expect(late).toEqual(ids.slice(firstPage!.length));
});

it("polls foreign commits and retains a commit that lands just after a drain read", async () => {
  local.changes.close();
  const prepare = local.db.prepare.bind(local.db);
  let inject = false,
    inserted = 0;
  vi.spyOn(local.db, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("FROM events WHERE id>")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
        const rows = all(...args);
        if (inject) {
          inject = false;
          inserted = insertForeign("one", "after-read");
        }
        return rows;
      });
    }
    return statement;
  });
  const bus = createChangeBus(local.db, { pollMs: 10 });
  const seen: CommittedEvent[] = [];
  bus.subscribe("one", (rows) => seen.push(...rows));
  try {
    await turn();
    inject = true;
    const first = insertForeign("one", "poll-wake");
    await expect.poll(() => seen.length).toBe(2);
    expect(seen.map((row) => row.id)).toEqual([first, inserted]);
    expect(seen.map((row) => row.type)).toEqual(["poll-wake", "after-read"]);
  } finally {
    bus.close();
  }
});

it("keeps a replacement subscription when an old unsubscribe is called again", async () => {
  const seen: string[] = [];
  const stopOld = local.changes.subscribe("one", () => {});
  stopOld();
  const stopNew = local.changes.subscribe("one", (rows) =>
    seen.push(...rows.map((row) => row.type)),
  );
  stopOld();
  local.emit("one", "one", "completed", {});
  await expect.poll(() => seen).toEqual(["completed"]);
  stopNew();
  expect(local.changes.subscriberCount).toBe(0);
});

it.each(["sample", "queued"])(
  "retries a failed %s read without waiting for a slow foreign poll",
  async (failure) => {
    local.changes.close();
    let armed = false,
      failures = 0;
    const prepare = local.db.prepare.bind(local.db);
    vi.spyOn(local.db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (failure === "queued" && sql.includes("FROM events WHERE id>")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          if (armed) {
            armed = false;
            failures++;
            throw new Error("transient page read");
          }
          return all(...args);
        });
      }
      return statement;
    });
    const bus = createChangeBus(local.db, { pollMs: 60000 });
    // Keep emit as the production entrypoint while instrumenting this connection.
    vi.spyOn(local.changes, "wake").mockImplementation(bus.wake);
    const pragma = local.db.pragma.bind(local.db);
    vi.spyOn(local.db, "pragma").mockImplementation((source, options) => {
      if (failure === "sample" && source === "data_version" && armed) {
        armed = false;
        failures++;
        throw new Error("transient version read");
      }
      return pragma(source, options);
    });
    const seen: string[] = [];
    bus.subscribe("one", (events) =>
      seen.push(...events.map((event) => event.type)),
    );
    try {
      armed = true;
      // No Cards/Done revision changes can supply another wake for this event.
      local.emit("one", "one", "attention.dismissed", {});
      await expect
        .poll(() => seen, { timeout: 1000 })
        .toEqual(["attention.dismissed"]);
      expect(failures).toBe(1);
    } finally {
      bus.close();
    }
  },
);

it.each([0, -1, NaN, Infinity, 2 ** 31])(
  "uses the default poll interval for invalid timer value %s",
  async (pollMs) => {
    local.changes.close();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const bus = createChangeBus(local.db, { pollMs });
    const seen: number[] = [];
    bus.subscribe("one", (events) =>
      seen.push(...events.map((event) => event.id)),
    );
    try {
      await turn();
      const expected = insertForeign("one", "default-poll");
      await vi.advanceTimersByTimeAsync(249);
      await turn();
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await turn();
      expect(seen).toEqual([expected]);
    } finally {
      bus.close();
      vi.useRealTimers();
    }
  },
);
