import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import Database from "better-sqlite3";

{
  const name = "loop.db";
  test("backup reads the workspace database and preserves its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-backup-"));
    try {
      const source = new Database(join(dir, name));
      source.exec(
        "CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('retained')",
      );
      source.close();
      const target = join(dir, "snapshot.db");
      execFileSync(process.execPath, [resolve("scripts/backup.mjs"), target], {
        env: { PATH: process.env.PATH, LOOP_DATA_DIR: dir },
      });
      const db = new Database(target, { readonly: true });
      assert.deepEqual(db.prepare("SELECT * FROM sentinel").all(), [
        { value: "retained" },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("service-worker activation retires earlier shell caches and fetch uses its own cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-worker-"));
  try {
    mkdirSync(join(dir, "dist/client"), { recursive: true });
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "dist/client/index.html"), "fixture");
    writeFileSync(join(dir, "public/push-events.js"), "");
    execFileSync(process.execPath, [resolve("scripts/build-sw.mjs")], {
      cwd: dir,
    });
    const handlers = new Map<string, (event: any) => void>();
    const stores = new Map<string, Map<string, string>>([
      ["loop-shell-old", new Map([["/offline.html", "stale"]])],
      ["unrelated-cache", new Map([["/offline.html", "foreign"]])],
    ]);
    let current = "";
    runInNewContext(readFileSync(join(dir, "dist/client/sw.js"), "utf8"), {
      URL,
      self: {
        location: { origin: "https://fixture.test" },
        clients: { claim: async () => {} },
        addEventListener: (name: string, fn: any) => handlers.set(name, fn),
      },
      caches: {
        keys: async () => [...stores.keys()],
        delete: async (name: string) => stores.delete(name),
        open: async (name: string) => {
          current = name;
          if (!stores.has(name)) stores.set(name, new Map());
          return {
            addAll: async (paths: string[]) => {
              for (const path of paths)
                stores.get(name)!.set(path, "current:" + path);
            },
            match: async (request: any) =>
              stores
                .get(name)!
                .get(
                  typeof request === "string"
                    ? request
                    : new URL(request.url).pathname,
                ),
          };
        },
        match: () => {
          throw new Error("Global cache lookup can expose stale assets");
        },
      },
      fetch: async () => {
        throw new Error("offline");
      },
    });
    let work: Promise<unknown> = Promise.resolve();
    handlers.get("install")!({
      waitUntil: (p: Promise<unknown>) => (work = p),
    });
    await work;
    handlers.get("activate")!({
      waitUntil: (p: Promise<unknown>) => (work = p),
    });
    await work;
    assert(!stores.has("loop-shell-old"));
    assert(stores.has("unrelated-cache"));
    assert(stores.has(current));
    for (const [path, mode] of [
      ["/", "navigate"],
      ["/offline.css", "same-origin"],
    ]) {
      handlers.get("fetch")!({
        request: { url: "https://fixture.test" + path, method: "GET", mode },
        respondWith: (p: Promise<unknown>) => (work = p),
      });
      assert.equal(
        await work,
        "current:" + (mode === "navigate" ? "/offline.html" : path),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
