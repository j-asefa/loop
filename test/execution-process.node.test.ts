import test from "node:test";
import assert from "node:assert/strict";
import {
  fork,
  spawn,
  execFileSync,
  type ChildProcess,
} from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { identity } from "../src/lifecycle.js";
import Database from "better-sqlite3";
import { until } from "./helpers.js";
import { gitProject } from "./git-project.js";
import { alive, groupAlive, terminateWorkspace } from "../src/daemon.js";

const owner = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "execution/owner.json"), "utf8")) as {
    pid: number;
    generation: string;
  };
function worker(dir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = fork(resolve("dist/server/execution-worker.js"), [], {
    execArgv: [],
    env: {
      ...process.env,
      LOOP_DATA_DIR: dir,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: any[] = [];
  let log = "";
  child.stdout!.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    log += chunk;
  });
  child.on("message", (message) => messages.push(message));
  return { child, messages, log: () => log };
}
async function ready(run: ReturnType<typeof worker>) {
  await until(
    () =>
      !!run.messages.find((m) => m.type === "ready") ||
      run.child.exitCode !== null ||
      run.child.signalCode !== null,
  );
  const message = run.messages.find((m) => m.type === "ready");
  assert(message, run.log());
  return message.ready.generation as string;
}
async function exchange(run: ReturnType<typeof worker>, message: any) {
  const id =
    message.type === "request" ? message.request.requestId : message.requestId;
  run.child.send(message);
  await until(() =>
    run.messages.some((m) => (m.response || m).requestId === id),
  );
  return run.messages.find((m) => (m.response || m).requestId === id);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGCONT");
  if (child.connected) child.disconnect();
  try {
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      10_000,
    );
  } catch {
    child.kill("SIGKILL");
    await until(() => child.signalCode !== null);
  }
}

test(
  "compiled worker keeps ownership while paused and fences replacement claims and controls",
  { timeout: 45_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-execution-lock-"));
    const children: ChildProcess[] = [];
    let db: Database.Database | undefined;
    t.after(async () => {
      for (const child of children) await stop(child);
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const a = worker(dir);
    children.push(a.child);
    const generationA = await ready(a);
    db = new Database(join(dir, "loop.db"));
    db.prepare(
      "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES('prior','local-workspace','agent','prior','running','prior',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO native_dispatch(run_id,generation,digest,state,created_at) VALUES('prior',?,'digest','running',1)",
    ).run(generationA);
    a.child.kill("SIGSTOP");
    const b = worker(dir);
    children.push(b.child);
    await until(() => b.child.exitCode !== null);
    assert.equal(b.child.exitCode, 1, b.log());
    assert.match(b.log(), /holds the workspace lock/);
    assert(!b.messages.some((m) => m.type === "ready"));
    assert.equal(owner(dir).generation, generationA);
    assert.equal(
      (db.prepare("SELECT state FROM runs WHERE id='prior'").get() as any)
        .state,
      "running",
      "refused contender never recovers another worker's runs",
    );
    a.child.kill("SIGCONT");
    const valid = await exchange(a, {
      type: "request",
      request: {
        v: 1,
        requestId: randomUUID(),
        generation: generationA,
        owner: "local-workspace",
        method: "runtime.status",
        input: {},
      },
    });
    assert.equal(valid.response.ok, true, "resumed A retains its generation");
    a.child.kill("SIGKILL");
    await until(() => a.child.signalCode !== null);
    const c = worker(dir);
    children.push(c.child);
    const generationC = await ready(c);
    assert.notEqual(generationC, generationA);
    db.prepare(
      "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES('queued','local-workspace','diagnostic','diagnostic','queued','queued',1,1)",
    ).run();
    const staleStart = await exchange(c, {
      type: "lifecycle",
      requestId: randomUUID(),
      generation: generationA,
      action: "schedule",
    });
    assert.equal(staleStart.ok, false);
    assert.equal(
      (db.prepare("SELECT state FROM runs WHERE id='queued'").get() as any)
        .state,
      "queued",
    );
    assert.equal(
      (db.prepare("SELECT state FROM runs WHERE id='prior'").get() as any)
        .state,
      "running",
    );
    const staleControl = await exchange(c, {
      type: "request",
      request: {
        v: 1,
        requestId: randomUUID(),
        generation: generationA,
        owner: "local-workspace",
        method: "runtime.status",
        input: {},
      },
    });
    assert.equal(staleControl.response.error.status, 409);
    assert.equal(
      (
        await exchange(c, {
          type: "lifecycle",
          requestId: randomUUID(),
          generation: generationC,
          action: "schedule",
        })
      ).ok,
      true,
    );
    await until(
      () =>
        (db!.prepare("SELECT state FROM runs WHERE id='queued'").get() as any)
          .state === "completed",
    );
    assert.equal(
      (db.prepare("SELECT state FROM runs WHERE id='prior'").get() as any)
        .state,
      "interrupted",
    );
    assert.equal(
      (db.prepare("SELECT worker_id FROM runs WHERE id='queued'").get() as any)
        .worker_id,
      generationC,
    );
  },
);

test("compiled API imports leave upgrade recovery to the locked execution owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-execution-import-"));
  try {
    const path = join(dir, "harness-upgrades.json");
    const state = JSON.stringify({
      fixture: {
        commandId: randomUUID(),
        name: "codex",
        state: "running",
        message: "fixture",
      },
    });
    writeFileSync(path, state);
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(resolve("dist/server/native-sessions.js")).href)}); process.exit(0);`,
      ],
      {
        env: {
          ...process.env,
          LOOP_DATA_DIR: dir,
        },
        timeout: 15_000,
      },
    );
    assert.equal(
      readFileSync(path, "utf8"),
      state,
      "API reads must not reconcile worker-owned upgrade state",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const macEnvironment = (boot: string) => ({
  NODE_OPTIONS: `--import=${pathToFileURL(resolve("test/fixtures/execution-macos-hooks.mjs")).href}`,
  LOOP_TEST_BOOT_SESSION: boot,
});
for (const restart of [
  "container restart",
  "host reboot",
  "macOS host replacement",
  "macOS legacy metadata",
]) {
  test(
    `compiled recovery CLI requires a stopped generation after ${restart} and preserves data and the lock inode`,
    { timeout: 35_000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "loop-execution-recovery-")),
        dir = join(root, "workspace");
      const children: ChildProcess[] = [];
      let db: Database.Database | undefined;
      t.after(async () => {
        for (const child of children) await stop(child);
        db?.close();
        rmSync(root, { recursive: true, force: true });
      });
      const priorEnv = restart.startsWith("macOS")
        ? macEnvironment(randomUUID())
        : {};
      const nextEnv = restart.startsWith("macOS")
        ? macEnvironment(randomUUID())
        : {};
      const a = worker(dir, priorEnv);
      children.push(a.child);
      const generation = await ready(a),
        path = join(dir, "execution/owner.json");
      const original = readFileSync(path, "utf8"),
        lockInode = statSync(join(dir, "execution/ownership.sqlite")).ino;
      const cliAt = (environment: NodeJS.ProcessEnv, ...args: string[]) =>
        execFileSync(
          process.execPath,
          [resolve("dist/cli.js"), "recover-execution", ...args],
          {
            env: { ...process.env, ...environment, LOOP_HOME: root },
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      const cli = (...args: string[]) => cliAt(nextEnv, ...args);
      a.child.kill("SIGSTOP");
      assert.throws(
        () => cli("--stopped-generation", generation),
        /holds the workspace lock/,
      );
      assert.equal(readFileSync(path, "utf8"), original);
      a.child.kill("SIGKILL");
      await until(() => a.child.signalCode !== null);
      assert.throws(
        () => cliAt(priorEnv, "--stopped-generation", generation),
        /only for a stopped foreign PID namespace/,
      );
      // Host reboot can retain the namespace inode while changing its boot/init
      // identity. Docker smoke separately exercises an actual stopped container.
      const location =
        restart === "container restart"
          ? { namespace: "pid:[0]" }
          : restart === "host reboot"
            ? { namespaceIdentity: "prior-boot:1", identity: "prior-boot:2" }
            : restart === "macOS legacy metadata"
              ? { namespace: undefined, namespaceIdentity: undefined }
              : {};
      writeFileSync(
        path,
        JSON.stringify({ ...JSON.parse(original), ...location }),
      );
      writeFileSync(
        join(dir, "execution/children.json"),
        '[{"pid":2,"identity":"foreign"}]',
      );
      db = new Database(join(dir, "loop.db"));
      db.prepare(
        "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES('retained','local-workspace','agent','retained','running','retained',1,1)",
      ).run();
      db.prepare(
        "INSERT INTO native_dispatch(run_id,generation,digest,state,created_at) VALUES('retained',?,'digest','running',1)",
      ).run(generation);
      const b = worker(dir, nextEnv);
      children.push(b.child);
      await until(
        () =>
          b.child.exitCode !== null ||
          b.messages.some((m) => m.type === "ready"),
      );
      assert.equal(b.child.exitCode, 1);
      assert.match(b.log(), /another PID namespace/);
      assert.match(b.log(), /host reboot/);
      assert.match(cli(), new RegExp(generation));
      assert.match(cli(), /unclean host reboot/);
      assert.throws(
        () =>
          execFileSync(process.execPath, [resolve("dist/cli.js"), "stop"], {
            env: { ...process.env, ...nextEnv, LOOP_HOME: root },
            timeout: 10_000,
            stdio: "pipe",
          }),
        /another PID namespace lifetime/,
        "stop cannot interpret foreign PIDs as local processes",
      );
      assert.throws(
        () => cli("--stopped-generation", randomUUID()),
        /generation changed/,
      );
      assert(existsSync(path));
      assert.match(cli("--stopped-generation", generation), /archived/);
      assert(!existsSync(path));
      assert.equal(
        statSync(join(dir, "execution/ownership.sqlite")).ino,
        lockInode,
      );
      const archive = readdirSync(join(dir, "execution")).find((name) =>
        name.startsWith("retired-"),
      )!;
      assert.equal(
        JSON.parse(
          readFileSync(join(dir, "execution", archive, "owner.json"), "utf8"),
        ).generation,
        generation,
      );
      assert.equal(
        readFileSync(join(dir, "execution", archive, "children.json"), "utf8"),
        '[{"pid":2,"identity":"foreign"}]',
      );
      assert.equal(
        (db.prepare("SELECT state FROM runs WHERE id='retained'").get() as any)
          .state,
        "running",
        "recovery command never changes application state or replays effects",
      );
      const c = worker(dir, nextEnv);
      children.push(c.child);
      const next = await ready(c);
      assert.notEqual(next, generation);
      await exchange(c, {
        type: "lifecycle",
        requestId: randomUUID(),
        generation: next,
        action: "schedule",
      });
      await until(
        () =>
          (
            db!
              .prepare("SELECT state FROM runs WHERE id='retained'")
              .get() as any
          ).state === "interrupted",
      );
    },
  );
}

test(
  "compiled macOS worker refuses startup when its boot identity is unavailable",
  { timeout: 15_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-execution-mac-identity-"));
    const a = worker(dir, macEnvironment("unavailable"));
    t.after(async () => {
      await stop(a.child);
      rmSync(dir, { recursive: true, force: true });
    });
    await until(
      () =>
        a.child.exitCode !== null || a.messages.some((m) => m.type === "ready"),
    );
    assert.equal(
      a.child.exitCode,
      1,
      "unknown host identity must not reach execution readiness",
    );
    assert.match(a.log(), /Could not establish execution/);
    assert(
      !existsSync(join(dir, "loop.db")),
      "no application recovery before ownership is established",
    );
  },
);

test(
  "compiled macOS takeover respects a normalized identity across a timezone change",
  { timeout: 20_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-execution-mac-timezone-"));
    const environment = macEnvironment(randomUUID()),
      children: ChildProcess[] = [];
    const native = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { identity } from ${JSON.stringify(pathToFileURL(resolve("dist/lifecycle.js")).href)};
    console.log(JSON.stringify({ pid: process.pid, identity: identity(process.pid) }));
    setInterval(() => {}, 1000);
  `,
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...environment, TZ: "UTC" },
      },
    );
    t.after(async () => {
      for (const child of children) await stop(child);
      native.kill("SIGKILL");
      await until(() => !alive(native.pid!));
      rmSync(dir, { recursive: true, force: true });
    });
    let output = "";
    native.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    await until(() => output.includes("\n") || native.exitCode !== null);
    const recorded = JSON.parse(output) as { pid: number; identity: string };
    const a = worker(dir, { ...environment, TZ: "UTC" });
    children.push(a.child);
    await ready(a);
    writeFileSync(
      join(dir, "execution/children.json"),
      JSON.stringify([recorded]),
    );
    a.child.kill("SIGKILL");
    await until(() => a.child.signalCode !== null);
    const b = worker(dir, { ...environment, TZ: "Pacific/Honolulu" });
    children.push(b.child);
    await ready(b);
    assert(
      !alive(native.pid!),
      "replacement must stop the recorded group before becoming ready",
    );
  },
);

for (const stale of ["owner", "stop records"]) {
  test(
    `compiled macOS worker ignores a reused PID in stale ${stale} without signalling its new group`,
    { timeout: 20_000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "loop-execution-mac-reuse-"));
      const environment = macEnvironment(randomUUID()),
        children: ChildProcess[] = [];
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      t.after(async () => {
        for (const child of children) await stop(child);
        unrelated.kill("SIGKILL");
        await until(() => !alive(unrelated.pid!));
        rmSync(dir, { recursive: true, force: true });
      });
      await until(() => alive(unrelated.pid!));
      const a = worker(dir, environment);
      children.push(a.child);
      await ready(a);
      const path = join(dir, "execution/owner.json"),
        original = JSON.parse(readFileSync(path, "utf8"));
      a.child.kill("SIGKILL");
      await until(() => a.child.signalCode !== null);
      const reused = {
        pid: unrelated.pid,
        identity: "darwin-utc:Sat Jan  1 00:00:00 2000",
      };
      if (stale === "owner")
        writeFileSync(path, JSON.stringify({ ...original, ...reused }));
      else
        writeFileSync(
          join(dir, "execution/stop-records.json"),
          JSON.stringify([reused]),
        );
      const b = worker(dir, environment);
      children.push(b.child);
      assert.notEqual(await ready(b), original.generation);
      assert(
        !existsSync(join(dir, "execution/stop-records.json")),
        "replacement retires resolved records before readiness",
      );
      assert(
        alive(unrelated.pid!),
        "the unrelated process group remains running",
      );
    },
  );
}

test(
  "compiled forced-stop revalidation failure preserves the prior worker ownership record",
  { timeout: 20_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "loop-execution-stop-evidence-")),
      dir = join(root, "workspace");
    const a = worker(dir);
    t.after(async () => {
      await stop(a.child);
      rmSync(root, { recursive: true, force: true });
    });
    await ready(a);
    const path = join(dir, "execution/owner.json"),
      original = readFileSync(path, "utf8");
    a.child.kill("SIGKILL");
    await until(() => a.child.signalCode !== null);
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import promises from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const dir = process.env.LOOP_DATA_DIR, registry = join(dir, "children.json");
    const read = promises.readFile;
    let reads = 0;
    promises.readFile = async function(path, ...args) {
      // Change the registry only at final forced-stop validation, after its
      // initial process scan and the execution lock have been acquired.
      if (path === registry && ++reads === 2) fs.writeFileSync(registry, "[");
      return read.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const { forceStop } = await import(${JSON.stringify(pathToFileURL(resolve("dist/cli.js")).href)});
    await assert.rejects(forceStop(dir, undefined, "exited"), /Process records are unreadable/);
    assert.equal(reads, 2);
    assert.equal(fs.readFileSync(registry, "utf8"), "[");
    assert.equal(fs.readFileSync(join(dir, "execution/owner.json"), "utf8"), ${JSON.stringify(original)}, "failed validation must retain the real worker's generation and identity");
  `,
      ],
      {
        env: {
          ...process.env,
          LOOP_DATA_DIR: dir,
        },
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  },
);

test(
  "compiled host close retires resolved execution records and preserves root records",
  { timeout: 20_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-execution-retirement-"));
    try {
      const record = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
      import { identity } from ${JSON.stringify(pathToFileURL(resolve("dist/lifecycle.js")).href)};
      console.log(JSON.stringify({ pid: process.pid, identity: identity(process.pid) }));
    `,
          ],
          { encoding: "utf8" },
        ),
      );
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import assert from "node:assert/strict";
      import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
      import { join } from "node:path";
      import { ExecutionProcess } from ${JSON.stringify(pathToFileURL(resolve("dist/server/execution-process.js")).href)};
      const dir = process.env.LOOP_DATA_DIR, records = ${JSON.stringify(JSON.stringify([record]))};
      const host = new ExecutionProcess();
      await host.open();
      const lock = join(dir, "execution/ownership.sqlite"), inode = statSync(lock).ino;
      try {
        writeFileSync(join(dir, "execution/children.json"), records);
        writeFileSync(join(dir, "execution/stop-records.json"), records);
        writeFileSync(join(dir, "stop-records.json"), records);
      } finally { await host.close(); }
      assert(!existsSync(join(dir, "execution/owner.json")));
      assert(!existsSync(join(dir, "execution/stop-records.json")), "resolved stop records must not survive graceful close");
      assert(!existsSync(join(dir, "execution/children.json")), "resolved child records must not survive graceful close");
      assert.equal(readFileSync(join(dir, "stop-records.json"), "utf8"), records, "execution cleanup must not erase root records");
      assert.equal(statSync(lock).ino, inode);
      const replacement = new ExecutionProcess();
      try { await replacement.open(); } finally { await replacement.close(); }
    `,
        ],
        {
          env: {
            ...process.env,
            LOOP_DATA_DIR: dir,
          },
          timeout: 15_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "compiled forced stop retires a stopped execution owner while preserving its lock and application data",
  { timeout: 20_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "loop-execution-force-stop-")),
      dir = join(root, "workspace");
    const a = worker(dir);
    const children = [a.child];
    t.after(async () => {
      for (const child of children) await stop(child);
      rmSync(root, { recursive: true, force: true });
    });
    const generation = await ready(a);
    const lock = join(dir, "execution/ownership.sqlite"),
      inode = statSync(lock).ino;
    const db = new Database(join(dir, "loop.db"));
    db.prepare(
      "INSERT INTO runs(id,owner_id,kind,input,state,idempotency_key,created_at,updated_at) VALUES('retained','local-workspace','agent','retained','running','retained',1,1)",
    ).run();
    db.close();
    writeFileSync(
      join(dir, "children.json"),
      JSON.stringify([{ pid: a.child.pid, identity: identity(a.child.pid!) }]),
    );
    a.child.kill("SIGSTOP");
    const output = execFileSync(
      process.execPath,
      [resolve("dist/cli.js"), "stop", "--json"],
      {
        env: {
          ...process.env,
          LOOP_HOME: root,
          LOOP_TEST_STOP_GRACE_MS: "200",
        },
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.equal(JSON.parse(output).stopped, true);
    await until(() => a.child.signalCode !== null || a.child.exitCode !== null);
    assert(
      !existsSync(join(dir, "execution/owner.json")),
      "a verified stop must not require foreign-namespace recovery later",
    );
    assert.equal(statSync(lock).ino, inode);
    const preserved = new Database(join(dir, "loop.db"));
    assert.equal(
      (
        preserved
          .prepare("SELECT state FROM runs WHERE id='retained'")
          .get() as any
      ).state,
      "running",
      "offline stop never performs application recovery",
    );
    preserved.close();
    const b = worker(dir);
    children.push(b.child);
    assert.notEqual(await ready(b), generation);
  },
);

test(
  "compiled paired host replaces crashed workers without replay and parent death stops detached natives",
  { timeout: 70_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "loop-execution-crash-"));
    mkdirSync(join(dir, "project"));
    gitProject(join(dir, "project"));
    const audit = join(dir, "audit"),
      hold = join(dir, "answer-delivered");
    const host = fork(resolve("test/fixtures/execution-process-host.mjs"), [], {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LOOP_DATA_DIR: dir,
        LOOP_TEST_HARNESS: "codex",
        LOOP_TEST_AUDIT: audit,
        LOOP_TEST_OUTLIVE_STDIN: "1",
        LOOP_TEST_DECISION_HOLD: hold,
        LOOP_TEST_DECISION_AUDIT: join(dir, "answers"),
        NODE_OPTIONS: `--import=${pathToFileURL(resolve("test/fixtures/execution-process-hooks.mjs")).href}`,
      },
    });
    let launch: { origin: string; pair: string; pid: number } | undefined,
      log = "";
    host.on("message", (message) => {
      launch = message as typeof launch;
    });
    host.stdout!.on("data", (chunk) => {
      log += chunk;
    });
    host.stderr!.on("data", (chunk) => {
      log += chunk;
    });
    let db: Database.Database | undefined;
    t.after(async () => {
      await stop(host);
      const cleaned = await terminateWorkspace(dir, undefined, 1000);
      assert.deepEqual(cleaned, { unresolved: [], survivors: [] });
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await until(() => !!launch || host.exitCode !== null);
    assert(launch, log);
    assert.notEqual(
      owner(dir).pid,
      launch.pid,
      "native authority runs outside the HTTP process",
    );
    const { origin } = launch;
    const paired = await fetch(origin + "/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: new URLSearchParams(new URL(launch.pair).hash.slice(1)).get(
          "pair",
        ),
        name: "crash fixture",
      }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await fetch(origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json());
    const raw = (path: string, body?: object) =>
      fetch(origin + "/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          Origin: origin,
          "x-loop-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const api = async (path: string, body?: object) => {
      const response = await raw(path, body),
        value = await response.json();
      assert(
        response.ok,
        JSON.stringify({
          path,
          status: response.status,
          value,
          log: log.slice(-1000),
        }),
      );
      return value;
    };
    db = new Database(join(dir, "loop.db"));
    const state = (id: string) =>
      (db!.prepare("SELECT state FROM runs WHERE id=?").get(id) as any).state;
    const count = () => readFileSync(audit, "utf8").trim().split("\n").length;
    const nativePids = () =>
      JSON.parse(
        readFileSync(join(dir, "execution/children.json"), "utf8"),
      ) as { pid: number }[];
    const bootstrap = await api("/bootstrap");
    const agent = await api("/agents", {
      name: "crash-fixture",
      connectionId: "native-codex",
      model: "native-default",
      instructions: "Fixture",
      folderId: bootstrap.folders.find((f: any) => f.path)?.id,
    });
    const run = await api("/runs", {
      agentId: agent.id,
      input: "wait",
      idempotencyKey: randomUUID(),
    });
    await until(() => state(run.id) === "running" && existsSync(audit));
    const before = owner(dir),
      firstNative = nativePids();
    assert(firstNative.length > 0);
    process.kill(before.pid, "SIGSTOP");
    try {
      const started = performance.now();
      const transcript = await fetch(
        origin + "/api/conversations/" + run.conversation_id,
        { headers: { cookie }, signal: AbortSignal.timeout(2000) },
      );
      assert.equal(transcript.status, 200);
      await transcript.json();
      assert(
        performance.now() - started < 1000,
        "the HTTP event loop remains responsive while its worker is paused",
      );
    } finally {
      process.kill(before.pid, "SIGCONT");
    }
    const prompts = count();
    process.kill(before.pid, "SIGKILL");
    await until(
      () =>
        owner(dir).generation !== before.generation &&
        state(run.id) === "interrupted",
      20_000,
    );
    assert(
      firstNative.every(({ pid }) => !alive(pid)),
      "old native writers stop before recovery",
    );
    assert.equal(count(), prompts, "a crashed turn is never resubmitted");
    const decisionRun = await api("/runs", {
      agentId: agent.id,
      input: "approve",
      idempotencyKey: randomUUID(),
    });
    await until(
      () =>
        !!db!
          .prepare(
            "SELECT id FROM native_decisions WHERE run_id=? AND state='pending'",
          )
          .get(decisionRun.id),
    );
    const decision = db
      .prepare("SELECT * FROM native_decisions WHERE run_id=?")
      .get(decisionRun.id) as any;
    const commandId = randomUUID();
    const answer = raw(`/native/decisions/${decision.id}`, {
      commandId,
      answer: { choice: "decline" },
    });
    await until(() => existsSync(hold) && existsSync(join(dir, "answers")));
    assert.equal(
      (
        db
          .prepare("SELECT state FROM native_decisions WHERE id=?")
          .get(decision.id) as any
      ).state,
      "deciding",
    );
    const answering = owner(dir);
    process.kill(answering.pid, "SIGKILL");
    const lost = await answer;
    assert.equal(lost.status, 503);
    await until(
      () =>
        owner(dir).generation !== answering.generation &&
        (
          db!
            .prepare("SELECT state FROM native_decisions WHERE id=?")
            .get(decision.id) as any
        ).state === "unknown",
      20_000,
    );
    const retry = await raw(`/native/decisions/${decision.id}`, {
      commandId,
      answer: { choice: "decline" },
    });
    assert.equal(retry.status, 200);
    assert.equal(
      (await retry.json()).state,
      "unknown",
      "same-ID retry reconciles the saved unknown result",
    );
    assert.equal(
      (
        await raw(`/native/decisions/${decision.id}`, {
          commandId: randomUUID(),
          answer: { choice: "decline" },
        })
      ).status,
      409,
    );
    assert.equal(
      readFileSync(join(dir, "answers"), "utf8"),
      "answer\n",
      "the uncertain decision was delivered exactly once",
    );
    const lastRun = await api("/runs", {
      agentId: agent.id,
      input: "wait",
      idempotencyKey: randomUUID(),
    });
    await until(
      () =>
        state(lastRun.id) === "running" &&
        nativePids().length > 0 &&
        count() >= prompts + 2,
    );
    const lastWorker = owner(dir),
      lastNative = nativePids();
    host.kill("SIGKILL");
    await until(
      () =>
        host.signalCode !== null &&
        !alive(lastWorker.pid) &&
        !groupAlive(lastWorker.pid) &&
        lastNative.every(({ pid }) => !alive(pid)),
      20_000,
    );
    assert.equal(state(lastRun.id), "interrupted");
  },
);

test(
  "a host started with --fleet forks its execution worker with fleet authorization, and only then",
  { timeout: 40_000, skip: process.platform !== "linux" },
  () => {
    for (const fleet of [true, false]) {
      const dir = mkdtempSync(join(tmpdir(), "loop-execution-fleet-"));
      try {
        const argv = execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      const { ExecutionProcess } = await import("./src/server/execution-process.ts");
      const host = new ExecutionProcess();
      if (${fleet}) host.enableFleet();
      await host.open();
      try {
        const { pid } = JSON.parse(readFileSync(join(process.env.LOOP_DATA_DIR, "execution/owner.json"), "utf8"));
        console.log(JSON.stringify(readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0")));
      } finally { await host.close(); }
    `,
          ],
          {
            encoding: "utf8",
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) => !key.startsWith("LOOP_"),
                ),
              ),
              LOOP_DATA_DIR: dir,
            },
            timeout: 30_000,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const args = JSON.parse(argv.trim().split("\n").at(-1)!) as string[];
        assert(args.some((arg) => arg.endsWith("execution-worker.ts")));
        assert.equal(args.includes("--fleet"), fleet);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);
