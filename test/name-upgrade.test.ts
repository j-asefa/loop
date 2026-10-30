import Database from "better-sqlite3";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { retainedPath } from "../src/name-upgrade";
import { upgradeStorage } from "../src/client/name-upgrade";

const directories: string[] = [];
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "loop55-upgrade-"));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("uses the Loop55 store for new installs, retains an existing store and refuses ambiguity", () => {
  const dir = temporary();
  expect(retainedPath(dir, "loop55.db", "loop.db")).toBe(
    join(dir, "loop55.db"),
  );
  writeFileSync(join(dir, "loop.db"), "existing durable state");
  expect(retainedPath(dir, "loop55.db", "loop.db")).toBe(join(dir, "loop.db"));
  writeFileSync(join(dir, "loop55.db"), "another installation");
  expect(() => retainedPath(dir, "loop55.db", "loop.db")).toThrow("Both");
});

it("loads legacy environment credentials and paths through the production server config", () => {
  const dir = temporary();
  const module = pathToFileURL(resolve("src/server/config.ts")).href;
  const { stdout } = {
    stdout: execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const { config } = await import(${JSON.stringify(module)}); console.log(JSON.stringify({ data: config.data, url: config.url, encryption: process.env.LOOP55_ENCRYPTION_KEY, legacy: process.env.LOOP_ENCRYPTION_KEY }));`,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          LOOP_DATA_DIR: dir,
          LOOP_URL: "https://old.example",
          LOOP55_URL: "https://new.example",
          LOOP_ENCRYPTION_KEY: "fixture-only",
        },
      },
    ),
  };
  expect(JSON.parse(stdout)).toEqual({
    data: dir,
    url: "https://new.example",
    encryption: "fixture-only",
  });
});

it("migrates owner-scoped browser keys without overwriting current values or moving uncertain journals", () => {
  const map = new Map([
    ["loop-draft-text:alice:thread", "Alice draft"],
    ["loop-draft-text:bob:thread", "Bob draft"],
    ["loop55-draft-text:bob:thread", "New Bob draft"],
    ["loop:fleet-commands:v1:alice", "uncertain original command identity"],
    ["unrelated", "keep"],
  ]);
  const storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  } satisfies Storage;
  upgradeStorage(storage);
  upgradeStorage(storage);
  expect(Object.fromEntries(map)).toEqual({
    "loop55-draft-text:alice:thread": "Alice draft",
    "loop55-draft-text:bob:thread": "New Bob draft",
    "loop:fleet-commands:v1:alice": "uncertain original command identity",
    unrelated: "keep",
  });
});

it("upgrades harness metadata and notification triggers without changing owners, credentials or uncertain work", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    for (const name of readdirSync("migrations")
      .filter((name) => name.endsWith(".sql") && name < "139")
      .sort())
      db.exec(readFileSync(join("migrations", name), "utf8"));
    for (const owner of ["alice", "bob"]) {
      db.prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,metadata,created_at) VALUES(?,?,'codex','Native','encrypted original','connected',?,1)",
      ).run(
        owner + "-connection",
        owner,
        JSON.stringify({
          loopHarness: "codex",
          runtimeKind: "loop-local",
          custom: "loop_untouched",
        }),
      );
      db.prepare(
        "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,?,'agent','Original prompt','interrupted',?,?,1,1)",
      ).run(
        owner + "-run",
        owner,
        owner + "-identity",
        JSON.stringify({ uncertain: true, nativeSession: "loop_original" }),
      );
    }
    const runs = db.prepare("SELECT * FROM runs ORDER BY id").all();
    db.transaction(() =>
      db.exec(readFileSync("migrations/139-loop55-names.sql", "utf8")),
    ).immediate();
    expect(db.prepare("SELECT * FROM runs ORDER BY id").all()).toEqual(runs);
    for (const owner of ["alice", "bob"]) {
      const row = db
        .prepare("SELECT owner_id,secret,metadata FROM connections WHERE id=?")
        .get(owner + "-connection") as any;
      expect(row.owner_id).toBe(owner);
      expect(row.secret).toBe("encrypted original");
      expect(JSON.parse(row.metadata)).toEqual({
        loop55Harness: "codex",
        runtimeKind: "loop55-local",
        custom: "loop_untouched",
      });
    }
    const trigger = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='notify_run_attention'",
      )
      .get() as any;
    expect(trigger.sql).toContain("Open Loop55");
    expect(trigger.sql).not.toContain("Open Loop to");
  } finally {
    db.close();
  }
});

it("keeps both generations of workspace settings and credentials out of test subprocesses", () => {
  const module = pathToFileURL(resolve("scripts/test-runner.mjs")).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { testEnvironment } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(testEnvironment({ PATH: "fixture", LOOP_HOME: "old-workspace", LOOP55_HOME: "new-workspace", LOOP_ENCRYPTION_KEY: "old-fixture-secret", LOOP55_ENCRYPTION_KEY: "new-fixture-secret", LOOP_TEST_FLAG: "old-test", LOOP55_TEST_FLAG: "new-test" }, "vitest")));`,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual({
    PATH: "fixture",
    LOOP_TEST_FLAG: "old-test",
    LOOP55_TEST_FLAG: "new-test",
    LOOP55_PROFILE: "server",
  });
});
