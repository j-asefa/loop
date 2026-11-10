import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspectWorkspace, control } from "../src/host-control.js";
import { identity, ProcessRecordError } from "../src/process-records.js";

test("workspace inspection distinguishes records, responses and process state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-host-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ pid: process.pid, workspace: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
  });
  assert.deepEqual(await inspectWorkspace(dir), { state: "absent" });
  await writeFile(join(dir, "control.json"), "null");
  assert.equal((await inspectWorkspace(dir)).state, "invalid");
  await assert.rejects(control(dir, "status"), ProcessRecordError);
  await writeFile(
    join(dir, "control.json"),
    JSON.stringify({
      port: (server.address() as AddressInfo).port,
      token: "fixture-token",
    }),
  );
  assert.equal(
    (await inspectWorkspace(dir)).state,
    "invalid",
    "a present control record requires its owner",
  );
  await writeFile(
    join(dir, "host.lock"),
    JSON.stringify({ pid: process.pid, identity: identity(process.pid) }),
  );
  const ready = await inspectWorkspace(dir);
  assert.equal(ready.state, "responding");
  assert(ready.state === "responding");
  assert.equal(ready.status.pid, process.pid);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.equal((await inspectWorkspace(dir)).state, "running");
  await writeFile(
    join(dir, "host.lock"),
    JSON.stringify({ pid: process.pid, identity: "" }),
  );
  assert.equal((await inspectWorkspace(dir)).state, "unknown");
  await writeFile(
    join(dir, "host.lock"),
    JSON.stringify({ pid: 99999999, identity: "dead" }),
  );
  assert.equal((await inspectWorkspace(dir)).state, "exited");
  await rm(join(dir, "control.json"));
  assert.equal(
    (await inspectWorkspace(dir)).state,
    "absent",
    "a stale lock alone remains recoverable by startup",
  );
  await mkdir(join(dir, "control.json"));
  const unreadable = await inspectWorkspace(dir);
  assert.equal(unreadable.state, "invalid");
  assert(unreadable.state === "invalid");
  assert.match(unreadable.error.message, /Unreadable local host record/);
});

test("inspection observes a normal shutdown between control and owner reads as absent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "loop-status-shutdown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controlPath = join(dir, "control.json");
  const ownerPath = join(dir, "host.lock");
  await writeFile(
    controlPath,
    JSON.stringify({ port: 1, token: "fixture-token" }),
  );
  await writeFile(
    ownerPath,
    JSON.stringify({ pid: process.pid, identity: identity(process.pid) }),
  );
  const read = fs.readFile;
  let removed = false;
  const intercepted = t.mock.method(
    fs,
    "readFile",
    async (path: Parameters<typeof read>[0], options: any) => {
      const contents = await read(path, options);
      if (path === controlPath && !removed) {
        removed = true;
        await rm(controlPath);
        await rm(ownerPath);
      }
      return contents;
    },
  );
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await inspectWorkspace(dir), { state: "absent" });
    assert.equal(removed, true, "shutdown happened after reading control");
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
});
