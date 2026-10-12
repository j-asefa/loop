import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  copyFile,
  chmod,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  appendFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  retireLog,
  alive,
  terminateWorkspace,
  LOG_MAX_BYTES,
} from "../src/daemon.js";
import { forceStop } from "../src/cli.js";
import { identity } from "../src/lifecycle.js";
import { until } from "./helpers.js";
import { gitProject } from "./git-project.js";

const exec = promisify(execFile);
const PAIR_URL = /http:\/\/127\.0\.0\.1:\d+\/#pair=[\w-]+/;

async function workspace(extraEnv: Record<string, string> = {}) {
  // The fixture harness is executed, and the system temp dir may be noexec.
  await mkdir(".tmp", { recursive: true });
  const base = await mkdtemp(join(resolve(".tmp"), "loop-daemon-"));
  const project = join(base, "project");
  await mkdir(project);
  gitProject(project);
  const fixture = join(base, "codex");
  await copyFile(resolve("test/harness.mjs"), fixture);
  await chmod(fixture, 0o755);
  // Neutral starts discover PATH. Keep them independent of harnesses installed
  // and signed in on the developer's machine; explicit fixtures still run.
  const bin = join(base, "bin");
  await mkdir(bin);
  for (const name of ["codex", "claude", "pi", "opencode"])
    await writeFile(join(bin, name), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: bin + ":" + (process.env.PATH || ""),
    LOOP_HOME: join(base, "state"),
    LOOP_TEST_HARNESS: "codex",
    ...extraEnv,
  };
  const cli = ["--import", "tsx", "src/cli.ts"];
  const loop = (args: string[], timeout = 30000) =>
    exec(process.execPath, [...cli, ...args], { env, timeout });
  const harness = [
    "codex",
    "--executable",
    fixture,
    "--project",
    project,
    "--billing",
    "existing",
  ];
  const status = async () =>
    JSON.parse((await loop(["status", "--json"])).stdout);
  const pids = new Set<number>();
  const start = async (...extra: string[]) => {
    const { stdout } = await loop([...harness, "--local-only", ...extra]);
    const { pid } = await status();
    pids.add(pid);
    return { stdout, pid: pid as number };
  };
  const cleanup = async () => {
    await loop(["stop"]).catch(() => {});
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    await rm(base, { recursive: true, force: true });
  };
  const dir = join(env.LOOP_HOME, "workspace");
  return { loop, harness, start, status, cleanup, dir, env, cli };
}

test("the daemon log rotates at its size cap without losing or splitting a line", async () => {
  const base = await mkdtemp(join(tmpdir(), "loop-log-"));
  const log = join(base, "daemon.log");
  try {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    await logged(
      log,
      `installDaemonLog(process.env.LOG, 300);
       for (let i = 0; i < 60; i++) (i % 2 ? console.error : console.log)("line " + i);`,
    );
    const current = await readFile(log, "utf8");
    const previous = await readFile(log + ".1", "utf8");
    assert(current.length <= 300 && previous.length <= 300);
    const kept = (previous + current).trimEnd().split("\n");
    assert.deepEqual(kept, lines.slice(lines.length - kept.length));
    assert(kept.length > 300 / 9, "the newest lines up to two files are kept");
    for (const file of [log, log + ".1"])
      assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Runs a script in a separate process, since the log takes over stdout and stderr.
function logged(log: string, script: string) {
  return exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { installDaemonLog } from ${JSON.stringify(resolve("src/daemon.ts"))};
       ${script}`,
    ],
    { env: { ...process.env, LOG: log } },
  );
}

test("a failed rotation keeps logging to the current file and says why", async () => {
  const base = await mkdtemp(join(tmpdir(), "loop-log-"));
  const log = join(base, "daemon.log");
  try {
    // A non-empty directory can't be replaced by the rotated file.
    await mkdir(log + ".1");
    await writeFile(join(log + ".1", "keep"), "");
    await logged(
      log,
      `installDaemonLog(process.env.LOG, 16);
       for (let i = 0; i < 3; i++) console.log("line " + i);`,
    );
    const lines = (await readFile(log, "utf8")).trimEnd().split("\n");
    assert.deepEqual(
      lines.filter((l) => l.startsWith("line")),
      ["line 0", "line 1", "line 2"],
    );
    assert.match(lines.join("\n"), /could not rotate/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a rotation whose new file fails to open resumes the current log later", async () => {
  const base = await mkdtemp(join(tmpdir(), "loop-log-"));
  const log = join(base, "daemon.log");
  try {
    await logged(
      log,
      `import { createRequire, syncBuiltinESMExports } from "node:module";
       const fs = createRequire(import.meta.url)("node:fs");
       installDaemonLog(process.env.LOG, 10);
       console.log("line 0");
       // The rename succeeds, then opening the new file fails once.
       const open = fs.openSync;
       fs.openSync = () => {
         fs.openSync = open;
         syncBuiltinESMExports();
         throw new Error("injected open failure");
       };
       syncBuiltinESMExports();
       for (let i = 1; i < 3; i++) console.log("line " + i);`,
    );
    const previous = await readFile(log + ".1", "utf8");
    assert.match(previous, /^line 0\n.*injected open failure.*\nline 1\n$/);
    assert.equal(
      await readFile(log, "utf8"),
      "line 2\n",
      "the next rotation opens daemon.log again instead of renaming",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a crash after rotations still leaves its trace in the current log", async () => {
  const base = await mkdtemp(join(tmpdir(), "loop-log-"));
  const log = join(base, "daemon.log");
  try {
    await assert.rejects(
      logged(
        log,
        `installDaemonLog(process.env.LOG, 200);
         for (let i = 0; i < 100; i++) console.log("line " + i);
         throw new Error("CRASH-MARKER");`,
      ),
    );
    assert.match(await readFile(log, "utf8"), /Error: CRASH-MARKER\n\s+at /);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a relaunch retires the old log with pairing secrets redacted", async () => {
  const base = await mkdtemp(join(tmpdir(), "loop-log-"));
  const log = join(base, "daemon.log");
  try {
    await writeFile(
      log,
      "Loop workspace ready.\nhttp://127.0.0.1:1/#pair=AbC_d-123456789012345678901234567890123\n",
      { mode: 0o644 },
    );
    await retireLog(log);
    const retired = await readFile(log + ".1", "utf8");
    assert.match(retired, /Loop workspace ready/);
    assert.match(retired, /#pair=<redacted>/);
    assert.doesNotMatch(retired, /AbC_d/);
    assert.equal((await stat(log + ".1")).mode & 0o777, 0o600);
    assert(!existsSync(log), "the next launch starts a fresh 0600 log");

    // An oversized legacy log keeps only its whole lines within the cap.
    const secret = "#pair=Zz_" + "x".repeat(40);
    await writeFile(
      log,
      "old " +
        secret +
        "\n" +
        "y".repeat(LOG_MAX_BYTES) +
        "\nnewest " +
        secret +
        "\n",
    );
    await retireLog(log);
    const kept = await readFile(log + ".1", "utf8");
    assert.equal(kept, "newest #pair=<redacted>\n");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("loop <harness> backgrounds after pairing; status, pair, stop and bare loop", async () => {
  const w = await workspace();
  try {
    const started = Date.now();
    const { stdout, pid } = await w.start();
    assert.equal(
      JSON.parse(await readFile(join(w.dir, "preferences.json"), "utf8"))
        .project,
      undefined,
      "a one-off harness launch does not replace the start project's default",
    );
    assert(
      Date.now() - started < 20000,
      "parent returns once pairing is shown",
    );
    const url = new URL(stdout.match(PAIR_URL)![0]);
    assert.match(stdout, /running in the background/);
    assert.equal((await w.status()).state, "ready");
    assert(alive(pid), "workspace outlives the command that started it");
    assert.equal(
      JSON.parse(await readFile(join(w.dir, "control.json"), "utf8")).pid,
      pid,
    );

    const paired = await fetch(url.origin + "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify({
        secret: new URLSearchParams(url.hash.slice(1)).get("pair"),
      }),
    });
    assert.equal(paired.status, 200, "backgrounded host serves pairing");

    const again = await w.loop(["pair"]);
    assert.match(again.stdout, /reconnect/);
    assert.match(again.stdout, new RegExp(url.origin + "/#pair="));

    const logs = await w.loop(["logs"]);
    assert.match(logs.stdout, /Loop workspace ready/);
    assert.doesNotMatch(
      logs.stdout,
      /#pair=/,
      "pairing codes reach the terminal, not the log",
    );

    await assert.rejects(
      w.loop(["--project", "."]),
      /Run loop stop before changing/,
    );

    const stopped = JSON.parse((await w.loop(["stop", "--json"])).stdout);
    assert.equal(stopped.stopped, true);
    assert(!alive(pid), "loop stop waits for the detached process to exit");
    assert.equal((await w.status()).state, "stopped");
  } finally {
    await w.cleanup();
  }
});

test("a startup failure in the background process reaches the terminal", async () => {
  const w = await workspace();
  try {
    const failed = await w
      .loop([...w.harness, "--public-url", "http://insecure.example"])
      .then(
        () => assert.fail("startup should fail"),
        (e: { stderr: string; code: number }) => e,
      );
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Public origin must be a bare HTTPS origin/);
    assert.doesNotMatch(failed.stderr, /exited during startup/);
    assert.equal((await w.status()).state, "stopped");
  } finally {
    await w.cleanup();
  }
});

test("crashed and hung workspaces: status, stop, relaunch and log rotation", async () => {
  // The native harness must be stopped by loop stop, not by its pipes closing.
  const w = await workspace({
    LOOP_TEST_OUTLIVE_STDIN: "1",
    // A frozen workspace ignores SIGTERM until SIGKILL; don't wait 5s for it.
    LOOP_TEST_STOP_GRACE_MS: "1000",
  });
  let follower: ReturnType<typeof spawn> | undefined;
  const natives: number[] = [];
  try {
    const first = await w.start();
    follower = spawn(process.execPath, [...w.cli, "logs", "--follow"], {
      env: w.env,
    });
    let followed = "";
    follower.stdout!.on("data", (b) => (followed += b));

    // A crashed workspace leaves its detached native harness running.
    const orphan = await nativeChild(
      w.dir,
      new URL(first.stdout.match(PAIR_URL)![0]),
    );
    natives.push(orphan);
    process.kill(first.pid, "SIGKILL");
    await until(() => !alive(first.pid));
    assert(alive(orphan));
    assert.equal((await w.status()).state, "crashed");
    const cleared = JSON.parse((await w.loop(["stop", "--json"])).stdout);
    assert.equal(cleared.stopped, true, "stop clears a crashed workspace");
    await until(() => !alive(orphan), 5000);
    assert(!existsSync(join(w.dir, "children.json")));
    assert.equal((await w.status()).state, "stopped");

    const second = await w.start();
    assert.match(
      await readFile(join(w.dir, "daemon.log.1"), "utf8"),
      /Loop workspace ready/,
      "a relaunch rotates the previous log",
    );
    await until(
      () => (followed.match(/Loop workspace ready/g)?.length ?? 0) >= 2,
      10000,
    );

    // A native conversation starts the harness in its own process group.
    const origin = new URL(second.stdout.match(PAIR_URL)![0]);
    const child = await nativeChild(w.dir, origin);
    natives.push(child);

    // A frozen process never answers the control socket.
    process.kill(second.pid, "SIGSTOP");
    await w.status().then((s) => assert.equal(s.state, "unresponsive"));
    // Records that no longer (or can't be shown to) belong to the workspace.
    // These must live until cleanup even when stop/relaunch is slow under load.
    const reused = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const unverifiable = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    const children = JSON.parse(
      await readFile(join(w.dir, "children.json"), "utf8"),
    );
    await writeFile(
      join(w.dir, "children.json"),
      JSON.stringify([
        ...children,
        { pid: reused.pid, identity: "another-process" },
        { pid: unverifiable.pid, identity: "" },
      ]),
    );
    try {
      const stopped = await w.loop(["stop", "--json"]).then(
        () => assert.fail("an unresolved record makes the stop incomplete"),
        (e: { stderr: string }) => e,
      );
      assert.match(stopped.stderr, /not responding; terminating it/);
      assert.match(
        stopped.stderr,
        new RegExp(
          `1 recorded native process\\(es\\) \\(${unverifiable.pid}\\)`,
        ),
      );
      assert(!alive(second.pid), "an unresponsive workspace is terminated");
      await until(() => !alive(child), 5000);
      assert(alive(reused.pid!), "a reused PID is not signalled");
      assert(alive(unverifiable.pid!), "an unconfirmed PID is left alone");
      assert(!existsSync(join(w.dir, "control.json")));
      assert.equal((await w.status()).state, "stopped");
      assert.deepEqual(
        JSON.parse(await readFile(join(w.dir, "stop-records.json"), "utf8")),
        [{ pid: unverifiable.pid, identity: "" }],
        "only the unresolved record is kept",
      );
      // A later stop retries it, and finishes once it has gone.
      await assert.rejects(w.loop(["stop"]), /could not be confirmed/);
      // So does stopping a relaunched workspace, which keeps the record.
      const third = await w.start();
      assert.deepEqual(
        JSON.parse(await readFile(join(w.dir, "stop-records.json"), "utf8")),
        [{ pid: unverifiable.pid, identity: "" }],
      );
      await assert.rejects(w.loop(["stop"]), /could not be confirmed/);
      assert(!alive(third.pid), "the relaunched workspace itself stopped");
      unverifiable.kill("SIGKILL");
      await until(() => !alive(unverifiable.pid!));
      assert.equal(
        JSON.parse((await w.loop(["stop", "--json"])).stdout).stopped,
        true,
      );
      for (const file of ["children.json", "stop-records.json"])
        assert(!existsSync(join(w.dir, file)));
    } finally {
      reused.kill("SIGKILL");
      unverifiable.kill("SIGKILL");
    }
  } finally {
    follower?.kill();
    for (const pid of natives) if (alive(pid)) process.kill(-pid, "SIGKILL");
    await w.cleanup();
  }
});

test("loop stop and status never act on a PID they can't confirm is the workspace", async () => {
  const w = await workspace();
  const other = spawn("sleep", ["60"]);
  try {
    await mkdir(w.dir, { recursive: true });
    // Nothing listens here, so the control socket never answers.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const record = async (identity: string) => {
      await writeFile(
        join(w.dir, "control.json"),
        JSON.stringify({ port, token: "x", pid: other.pid }),
      );
      await writeFile(
        join(w.dir, "host.lock"),
        JSON.stringify({ pid: other.pid, identity, nonce: "n" }),
      );
    };

    await record("");
    assert.equal((await w.status()).state, "unknown");
    await assert.rejects(w.loop(["stop"]), /can't confirm/);
    assert(alive(other.pid!), "an unconfirmed PID is not signalled");

    await record("a process that has since exited");
    assert.equal((await w.status()).state, "crashed");
    assert.equal(JSON.parse((await w.loop(["stop"])).stdout).stopped, true);
    assert(alive(other.pid!), "a reused PID is not signalled");
    assert(!existsSync(join(w.dir, "control.json")));
  } finally {
    other.kill("SIGKILL");
    await w.cleanup();
  }
});

test("a forced stop kills group members that outlive their leader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-group-"));
  // A detached leader that exits on SIGTERM (noting it got a chance to shut
  // down cleanly), and a member of its process group that ignores SIGTERM.
  const mark = join(dir, "leader-signal");
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(mark)}, "SIGTERM"); process.exit(0); });
       const member = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1e9)"], { stdio: ["ignore", "pipe", "ignore"] });
       member.stdout.once("data", () => console.log(member.pid));
       setInterval(() => {}, 1e9);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let member = 0;
  try {
    member = await new Promise<number>((r) =>
      leader.stdout!.once("data", (b) => r(Number(String(b).trim()))),
    );
    await writeFile(
      join(dir, "children.json"),
      JSON.stringify([{ pid: leader.pid, identity: identity(leader.pid!) }]),
    );
    const result = await terminateWorkspace(dir, undefined, 1000);
    assert.deepEqual(result, { unresolved: [], survivors: [] });
    assert(!alive(leader.pid!));
    assert.equal(
      await readFile(mark, "utf8"),
      "SIGTERM",
      "SIGTERM comes before SIGKILL",
    );
    assert(!alive(member), "the member that ignored SIGTERM got SIGKILL");
  } finally {
    for (const pid of [leader.pid!, member])
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a later stop still kills group members an interrupted one left behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-group-"));
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const member = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1e9)"], { stdio: ["ignore", "pipe", "ignore"] });
       member.stdout.once("data", () => console.log(member.pid));
       setInterval(() => {}, 1e9);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let member = 0;
  try {
    member = await new Promise<number>((r) =>
      leader.stdout!.once("data", (b) => r(Number(String(b).trim()))),
    );
    await writeFile(
      join(dir, "children.json"),
      JSON.stringify([{ pid: leader.pid, identity: identity(leader.pid!) }]),
    );
    // The first attempt ends after SIGTERM: the leader exits, the member doesn't.
    const first = await terminateWorkspace(dir, undefined, 1000, (pid, sig) => {
      if (sig === "SIGTERM") process.kill(pid, sig);
    });
    assert.deepEqual(first.survivors, [leader.pid]);
    await until(() => !alive(leader.pid!));
    assert(alive(member));
    const second = await terminateWorkspace(dir, undefined, 1000);
    assert.deepEqual(second, { unresolved: [], survivors: [] });
    assert(
      !alive(member),
      "the member recorded by the first attempt is stopped",
    );
  } finally {
    for (const pid of [leader.pid!, member])
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live workspace rewriting its registry can't drop members a stop recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-group-"));
  const registry = join(dir, "children.json");
  // A stand-in workspace: it records a detached leader with the real registry
  // writer, which rewrites children.json when that leader exits.
  const host = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { spawn } from "node:child_process";
       import { recordOwnedProcesses, own } from ${JSON.stringify(resolve("src/processes.ts"))};
       recordOwnedProcesses(process.env.REGISTRY);
       const leader = spawn(process.execPath, ["-e", ${JSON.stringify(
         `const { spawn } = require("node:child_process");
          const member = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1e9)"], { stdio: ["ignore", "pipe", "ignore"] });
          member.stdout.once("data", () => console.log(member.pid));
          setInterval(() => {}, 1e9);`,
       )}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
       own(leader);
       leader.stdout.once("data", (b) => console.log(leader.pid + " " + String(b).trim()));
       setInterval(() => {}, 1e9);`,
    ],
    {
      env: { ...process.env, REGISTRY: registry },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let leader = 0,
    member = 0;
  try {
    [leader, member] = await new Promise<number[]>((r) =>
      host.stdout!.once("data", (b) =>
        r(String(b).trim().split(" ").map(Number)),
      ),
    );
    // Interrupted after SIGTERM: the leader exits and the workspace forgets it.
    const first = await terminateWorkspace(dir, undefined, 1000, (pid, sig) => {
      if (sig === "SIGTERM") process.kill(pid, sig);
    });
    assert.deepEqual(first.survivors, [leader]);
    await until(() => readFileSync(registry, "utf8") === "[]");
    const second = await terminateWorkspace(dir, undefined, 1000);
    assert.deepEqual(second, { unresolved: [], survivors: [] });
    assert(!alive(member), "the member is still stopped");
  } finally {
    host.kill("SIGKILL");
    for (const pid of [leader, member])
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a group whose leader exited before the stop is kept and reported, not signalled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-group-"));
  const registry = join(dir, "children.json");
  // The leader starts a member of its group, then exits on its own.
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const member = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1e9)"], { stdio: ["ignore", "pipe", "ignore"] });
       member.stdout.once("data", () => { console.log(member.pid); member.unref(); member.stdout.destroy(); });`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  let member = 0;
  try {
    const record = { pid: leader.pid!, identity: identity(leader.pid!)! };
    member = await new Promise<number>((r) =>
      leader.stdout!.once("data", (b) => r(Number(String(b).trim()))),
    );
    await writeFile(registry, JSON.stringify([record]));
    await until(() => !alive(leader.pid!));
    await assert.rejects(
      forceStop(dir, undefined, "exited"),
      new RegExp(`\\(${leader.pid}\\) could not be confirmed`),
    );
    assert(
      alive(member),
      "a group that can't be tied to its leader is left alone",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "stop-records.json"), "utf8")),
      [record],
    );
    process.kill(member, "SIGKILL");
    await until(() => !alive(member));
    await forceStop(dir, undefined, "exited");
    for (const file of [registry, join(dir, "stop-records.json")])
      assert(!existsSync(file), "resolved once the group is empty");
  } finally {
    if (member && alive(member)) process.kill(member, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a forced stop that leaves survivors fails and keeps the records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-survivor-"));
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  const registry = join(dir, "children.json");
  try {
    await writeFile(
      registry,
      JSON.stringify([{ pid: child.pid, identity: identity(child.pid!) }]),
    );
    // Signals that never land stand in for a process that survives SIGKILL.
    process.env.LOOP_TEST_STOP_GRACE_MS = "500";
    await assert.rejects(
      forceStop(dir, undefined, "exited", () => {}),
      new RegExp(`Process\\(es\\) ${child.pid} did not exit`),
    );
    assert(existsSync(registry), "the record is kept for another attempt");
    assert(alive(child.pid!));
  } finally {
    delete process.env.LOOP_TEST_STOP_GRACE_MS;
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a workspace that acknowledges stop but never exits is terminated", async () => {
  // Preloaded into the background workspace only: something keeps it alive
  // after it has shut down.
  await mkdir(".tmp", { recursive: true });
  const preload = join(resolve(".tmp"), `hang-${process.pid}.mjs`);
  await writeFile(
    preload,
    'if (process.env.LOOP_DAEMON_CHILD === "1") setInterval(() => {}, 1 << 30);\n',
  );
  const w = await workspace({
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload)}`,
    LOOP_TEST_STOP_WAIT_MS: "2000",
    LOOP_TEST_STOP_GRACE_MS: "1000",
  });
  try {
    const { pid } = await w.start();
    const stopped = await w.loop(["stop", "--json"], 60000);
    assert.match(stopped.stderr, /did not exit within 2s; terminating it/);
    assert.equal(JSON.parse(stopped.stdout).stopped, true);
    assert(!alive(pid));
    assert.equal((await w.status()).state, "stopped");
  } finally {
    await w.cleanup();
    await rm(preload, { force: true });
  }
});

test("loop logs --follow keeps the old file's tail across a rotation", async () => {
  const w = await workspace();
  const log = join(w.dir, "daemon.log");
  let follower: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(w.dir, { recursive: true });
    await writeFile(log, "first\n");
    follower = spawn(process.execPath, [...w.cli, "logs", "--follow"], {
      env: w.env,
    });
    let followed = "";
    follower.stdout!.on("data", (b) => (followed += b));
    await until(() => followed.includes("first"), 10000);
    // Between two polls: a line lands, then the log rotates.
    appendFileSync(log, "TAIL-BEFORE-ROTATION\n");
    renameSync(log, log + ".1");
    writeFileSync(log, "after rotation\n");
    await until(() => followed.includes("after rotation"), 10000);
    assert.equal(followed, "first\nTAIL-BEFORE-ROTATION\nafter rotation\n");
  } finally {
    follower?.kill();
    await w.cleanup();
  }
});

// Pairs, starts a native conversation, and returns the harness process it spawned.
async function nativeChild(dir: string, url: URL) {
  const paired = await fetch(url.origin + "/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url.origin },
    body: JSON.stringify({
      secret: new URLSearchParams(url.hash.slice(1)).get("pair"),
    }),
  });
  const cookie = paired.headers.get("set-cookie")!.split(";")[0];
  const { csrf } = await fetch(url.origin + "/session", {
    headers: { Cookie: cookie },
  }).then((r) => r.json() as Promise<{ csrf: string }>);
  const api = (path: string, body: object) =>
    fetch(url.origin + "/api" + path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: url.origin,
        "x-loop-csrf": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(
      (r) => r.json() as Promise<{ id: string; conversation_id: string }>,
    );
  // Agent names are unique, and the workspace outlives a daemon restart.
  const agent = await api("/agents", {
    name: "daemon-agent-" + crypto.randomUUID().slice(0, 8),
    connectionId: "native-codex",
    model: "native-default",
  });
  const run = await api("/runs", {
    agentId: agent.id,
    input: "daemon task",
    idempotencyKey: crypto.randomUUID(),
  });
  // Wait for the turn to finish, so the harness is idle like a real orphan
  // (a write mid-turn to a dead workspace's pipe would end it by itself).
  let done = false;
  const deadline = Date.now() + 15000;
  while (!done && Date.now() < deadline) {
    const history = (await fetch(
      url.origin + "/api/conversations/" + run.conversation_id,
      { headers: { Cookie: cookie } },
    ).then((r) => r.json())) as { messages?: { content: string }[] };
    done = !!history.messages?.some((m) => m.content === "Fixture done");
    if (!done) await new Promise((r) => setTimeout(r, 100));
  }
  assert(done, "the native turn completed");
  let pid = 0;
  await until(() => {
    try {
      pid = JSON.parse(readFileSync(join(dir, "children.json"), "utf8"))[0]
        ?.pid;
    } catch {
      /* Not written yet. */
    }
    return !!pid && alive(pid);
  }, 15000);
  return pid;
}

test("local-only overrides a saved public URL and named tunnel", async () => {
  const w = await workspace();
  try {
    await mkdir(w.dir, { recursive: true });
    await writeFile(
      join(w.dir, "preferences.json"),
      JSON.stringify({
        publicUrl: "https://saved-tunnel.invalid",
        tunnelName: "saved-tunnel",
        tunnelConfig: "/nonexistent/tunnel.yml",
      }),
    );
    const started = await w.start();
    assert.match(started.stdout, PAIR_URL);
    assert.doesNotMatch(started.stdout, /saved-tunnel/);
  } finally {
    await w.cleanup();
  }
});

test("loop acp refuses a relative or missing executable with setup guidance", async () => {
  const w = await workspace();
  try {
    for (const executable of ["./missing-agent", "/missing/acp-agent"])
      await assert.rejects(
        w.loop(["acp", "--executable", executable, "--local-only"]),
        /Choose an executable local ACP agent file/,
      );
  } finally {
    await w.cleanup();
  }
});

test("loop start --direct pairs with no installed harness, reuses the host and survives restart", async () => {
  const w = await workspace();
  try {
    // Automatic discovery must not depend on this machine's signed-in CLIs.
    const unavailable = join(w.dir, "unavailable-runtimes");
    await mkdir(unavailable, { recursive: true });
    for (const name of ["codex", "claude", "pi", "opencode"])
      await writeFile(join(unavailable, name), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    Object.assign(w.env, { PATH: `${unavailable}:${process.env.PATH}` });
    const first = await w.loop([
      "start",
      "--direct",
      "--local-only",
      "--project",
      w.env.LOOP_HOME,
    ]);
    assert.match(first.stdout, PAIR_URL);
    const status = await w.status();
    assert.equal(status.serverReady, true);
    assert.equal(status.executionReady, false);
    assert.deepEqual(status.harnesses, []);
    const resumed = await w.loop(["start", "--direct", "--local-only"]);
    assert.match(resumed.stdout, PAIR_URL);
    assert.equal((await w.status()).pid, status.pid);
    const again = await w.loop([
      "start",
      "--direct",
      "--local-only",
      "--project",
      w.env.LOOP_HOME,
    ]);
    assert.match(again.stdout, PAIR_URL);
    assert.equal((await w.status()).pid, status.pid);
    await assert.rejects(
      w.loop(["start", "--local-only", "--providers", "pi"]),
      /Run loop stop before changing the running workspace's providers/,
    );
    // The same set in another order or spelling is not a change.
    assert.match(
      (
        await w.loop([
          "start",
          "--local-only",
          "--providers",
          "opencode,pi,claude,codex",
        ])
      ).stdout,
      PAIR_URL,
    );
    const bare = await w.loop(["--direct", "--local-only"]);
    assert.match(bare.stdout, PAIR_URL);
    assert.equal((await w.status()).pid, status.pid);
    const otherProject = join(w.env.LOOP_HOME, "other-project");
    await mkdir(otherProject);
    await assert.rejects(
      w.loop(["start", "--direct", "--local-only", "--project", otherProject]),
      /Run loop stop before changing the running workspace/,
    );
    await assert.rejects(
      w.loop([
        "start",
        "--local-only",
        "--providers",
        "anthropic",
        "--execution",
        "docker",
      ]),
      /Use docker compose/,
    );
    assert.equal((await w.status()).pid, status.pid);
    // Each pairing request replaces only the unused prior code.
    const current = bare.stdout.match(PAIR_URL)![0];
    const origin = new URL(current).origin;
    const secret = new URL(current).hash.slice(6);
    const paired = await fetch(origin + "/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        name: "start test",
      }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const credentials = (await fetch(origin + "/session", {
      headers: { cookie },
    }).then((r) => r.json())) as any;
    await w.loop(["pair"]);
    assert.equal(
      (
        await fetch(origin + "/session", {
          headers: { cookie },
        })
      ).status,
      200,
    );
    await w.loop(["stop"]);
    await assert.rejects(w.loop(["pair"]), /loop start/);
    const restarted = await w.loop(["--direct", "--local-only"]);
    assert.equal((await w.status()).project, w.env.LOOP_HOME);
    const nextOrigin = new URL(restarted.stdout.match(PAIR_URL)![0]).origin;
    const session = await fetch(nextOrigin + "/session", {
      headers: { cookie },
    });
    assert.equal(session.status, 200);
    assert.equal(
      ((await session.json()) as any).device.id,
      credentials.device.id,
    );
    assert.deepEqual((await w.status()).harnesses, []);
  } finally {
    await w.cleanup();
  }
});

test("bare loop restores a saved managed project from another directory", async () => {
  const w = await workspace();
  try {
    await w.loop([
      "start",
      "--direct",
      "--local-only",
      "--project",
      w.env.LOOP_HOME,
    ]);
    const running = await w.status();
    const preferencesPath = join(w.dir, "preferences.json");
    const preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
    await writeFile(
      preferencesPath,
      JSON.stringify({
        ...preferences,
        providers: "openai",
        execution: "native",
      }),
    );
    const bare = await w.loop(["--local-only"]);
    assert.match(bare.stdout, PAIR_URL);
    assert.equal((await w.status()).pid, running.pid);
    assert.equal((await w.status()).project, w.env.LOOP_HOME);
  } finally {
    await w.cleanup();
  }
});
