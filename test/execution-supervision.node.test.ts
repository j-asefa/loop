import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { until } from "./helpers.js";
import { gitProject } from "./git-project.js";
import { terminateWorkspace } from "../src/daemon.js";

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "loop-supervision-"));
  mkdirSync(join(dir, "project"));
  gitProject(join(dir, "project"));
  const host = fork(resolve("test/fixtures/execution-process-host.mjs"), [], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      LOOP_PROFILE: "companion",
      LOOP_DATA_DIR: dir,
      LOOP_TEST_HARNESS: "codex",
      LOOP_TEST_SUPERVISION: dir,
      NODE_OPTIONS: `--import=${pathToFileURL(resolve("test/fixtures/execution-supervision-hooks.mjs")).href}`,
    },
  });
  let launched = false,
    log = "",
    origin = "";
  const replies = new Map<string, any>();
  host.on("message", (message: any) => {
    if (message.pair) {
      launched = true;
      origin = message.origin;
    }
    if (message.id) replies.set(message.id, message);
  });
  host.stdout!.on("data", (value) => {
    log += value;
  });
  host.stderr!.on("data", (value) => {
    log += value;
  });
  let db: Database.Database | undefined;
  t.after(async () => {
    for (const name of ["hold-requests", "hold-schedule", "hold-origin"])
      rmSync(join(dir, name), { force: true });
    if (host.connected) host.disconnect();
    try {
      await until(
        () => host.exitCode !== null || host.signalCode !== null,
        12_000,
      );
    } finally {
      if (host.exitCode === null && host.signalCode === null)
        host.kill("SIGKILL");
      await until(() => host.exitCode !== null || host.signalCode !== null);
      assert.deepEqual(await terminateWorkspace(dir, undefined, 1000), {
        unresolved: [],
        survivors: [],
      });
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await until(() => launched || host.exitCode !== null, 15_000);
  assert(launched, log);
  db = new Database(join(dir, "loop.db"));
  const ask = async (action: string, extra: object = {}) => {
    const id = randomUUID();
    host.send({ id, action, ...extra });
    await until(() => replies.has(id));
    return replies.get(id);
  };
  const owner = () =>
    JSON.parse(readFileSync(join(dir, "execution/owner.json"), "utf8")) as {
      pid: number;
      generation: string;
    };
  const file = (name: string) => join(dir, name);
  const queued = () => {
    const id = randomUUID();
    db!
      .prepare(
        "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES(?,'local-workspace','diagnostic','diagnostic','queued',?,1,1)",
      )
      .run(id, id);
    return () =>
      (
        db!.prepare("SELECT state FROM runs WHERE id=?").get(id) as {
          state: string;
        }
      ).state;
  };
  return { ask, owner, file, queued, origin };
}

test(
  "compiled supervisor retries a fork error that has no exit event",
  { timeout: 35_000 },
  async (t) => {
    const { owner, file, queued, ask } = await fixture(t),
      before = owner();
    writeFileSync(file("fail-fork"), "1");
    process.kill(before.pid, "SIGKILL");
    await until(() => existsSync(file("fork-failed")));
    await until(() => owner().generation !== before.generation, 8000);
    const state = queued();
    await until(() => state() === "completed");
    assert.equal((await ask("status")).status.executionReady, true);
  },
);

test(
  "compiled replacement stays unready until lifecycle restoration succeeds and retries a refusal",
  { timeout: 35_000 },
  async (t) => {
    const { owner, file, queued, ask } = await fixture(t),
      before = owner();
    writeFileSync(file("fail-schedule"), "1");
    writeFileSync(file("hold-schedule"), "1");
    process.kill(before.pid, "SIGKILL");
    await until(() => existsSync(file("schedule-held")));
    const refused = owner();
    assert.equal((await ask("status")).status.executionReady, false);
    const state = queued();
    assert.equal(state(), "queued");
    rmSync(file("hold-schedule"));
    await until(() => owner().generation !== refused.generation, 8000);
    await until(() => state() === "completed");
    assert.equal((await ask("status")).status.executionReady, true);
  },
);

test(
  "compiled supervisor delivers the latest origin while 128 requests are pending",
  { timeout: 35_000 },
  async (t) => {
    const { file, ask } = await fixture(t);
    writeFileSync(file("hold-requests"), "1");
    await ask("saturate");
    await until(
      () =>
        existsSync(file("held-requests")) &&
        readFileSync(file("held-requests"), "utf8") === "128",
    );
    await ask("origin", { origin: "https://previous.example" });
    await ask("origin", { origin: "https://current.example" });
    await until(
      () =>
        existsSync(file("origins")) &&
        readFileSync(file("origins"), "utf8")
          .trim()
          .endsWith("https://current.example"),
      5000,
    );
    assert.equal(readFileSync(file("held-requests"), "utf8"), "128");
    rmSync(file("hold-requests"));
  },
);

test(
  "compiled workspace closes its HTTP gateway even when execution cleanup rejects",
  { timeout: 25_000 },
  async (t) => {
    const { ask, origin } = await fixture(t);
    assert.equal((await fetch(origin)).status, 200);
    assert.match(
      (await ask("close-error")).error,
      /fixture execution cleanup error/,
    );
    await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1000) }));
  },
);

test(
  "compiled supervisor reports a locally saturated request as refused before sending it",
  { timeout: 25_000 },
  async (t) => {
    const { file, ask } = await fixture(t);
    writeFileSync(file("hold-requests"), "1");
    await ask("saturate", { count: 127 });
    await until(
      () =>
        existsSync(file("held-requests")) &&
        readFileSync(file("held-requests"), "utf8") === "127",
    );
    writeFileSync(file("hold-origin"), "1");
    await ask("origin", { origin: "https://held.example" });
    await until(() => existsSync(file("origin-held")));
    const response = await ask("runtime-status");
    assert.equal(response.status, 503);
    assert.equal(response.outcome, "refused");
    assert.equal(
      readFileSync(file("held-requests"), "utf8"),
      "127",
      "the rejected request never reached worker IPC",
    );
    rmSync(file("hold-origin"));
    rmSync(file("hold-requests"));
  },
);
