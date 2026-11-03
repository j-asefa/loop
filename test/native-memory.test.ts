import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as memory from "../src/native-memory";
import { Native, NativeTransportError } from "../src/native";
import { Codex } from "../src/adapters/codex";
import { Claude } from "../src/adapters/claude";
import { Pi } from "../src/adapters/pi";
import { OpenCode } from "../src/adapters/opencode";
import { Acp } from "../src/adapters/acp";
import type { AdapterEvent } from "../src/protocol";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) close();
});

function scopeFixture(child: ChildProcess) {
  const dir = mkdtempSync(join(tmpdir(), "loop-memory-evidence-"));
  const roots = { proc: join(dir, "proc"), cgroups: join(dir, "cgroup") };
  const group = `/user.slice/loop-agents.slice/loop-agent-${child.pid}-${"a".repeat(32)}.scope`;
  const scope = join(roots.cgroups, group.slice(1));
  const parent = join(scope, "..");
  const proc = join(roots.proc, String(child.pid));
  mkdirSync(proc, { recursive: true });
  mkdirSync(scope, { recursive: true });
  writeFileSync(join(proc, "cgroup"), `0::${group}\n`);
  writeFileSync(
    join(scope, "memory.events"),
    "oom 0\noom_kill 0\noom_group_kill 0\n",
  );
  writeFileSync(join(scope, "memory.max"), "max\n");
  writeFileSync(join(parent, "memory.max"), String(5 * 1024 ** 3));
  writeFileSync(join(parent, "memory.events"), "oom 20\noom_kill 20\n");
  cleanup.push(() => {
    child.emit("exit", 0, null);
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    roots,
    scope,
    proc,
    group,
    kill: (count = 1) =>
      writeFileSync(
        join(scope, "memory.events"),
        `oom 0\noom_kill ${count}\noom_group_kill 0\n`,
      ),
  };
}
function fakeChild() {
  return Object.assign(new EventEmitter(), { pid: 12345 }) as ChildProcess;
}

it("retains this launch's OOM evidence and shared budget after scope collection", () => {
  const child = fakeChild();
  const f = scopeFixture(child);
  const monitor = new memory.NativeMemoryMonitor(child, f.roots);
  expect(monitor.failure()).toBeUndefined();
  f.kill();
  expect(monitor.failure()).toMatchObject({
    code: "native_memory_limit",
    limitBytes: 5 * 1024 ** 3,
    shared: true,
  });
  child.emit("exit", null, "SIGTERM");
  rmSync(f.scope, { recursive: true });
  expect(monitor.failure()?.message).toContain("Out of memory.");
  expect(monitor.failure()?.message).toContain("5 GiB, shared across agents");
});

it("does not blame another agent's OOM, allocation pressure, or SIGKILL on this launch", () => {
  const child = fakeChild();
  const f = scopeFixture(child);
  writeFileSync(
    join(f.scope, "memory.events"),
    "max 100\noom 10\noom_kill 0\n",
  );
  const monitor = new memory.NativeMemoryMonitor(child, f.roots);
  expect(monitor.failure()).toBeUndefined();
  child.emit("exit", null, "SIGKILL");
  expect(monitor.failure()).toBeUndefined();
});

it("ignores the supervisor scope while the launcher moves into its own scope", async () => {
  const child = fakeChild();
  const f = scopeFixture(child);
  writeFileSync(join(f.proc, "cgroup"), "0::/user.slice/loop-agents.slice\n");
  const monitor = new memory.NativeMemoryMonitor(child, f.roots);
  expect(monitor.failure()).toBeUndefined();
  f.kill();
  writeFileSync(join(f.proc, "cgroup"), `0::${f.group}\n`);
  await vi.waitFor(() =>
    expect(monitor.failure()).toBeInstanceOf(memory.NativeMemoryError),
  );
});

it("reports a tighter per-launch limit and expires old evidence", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const child = fakeChild();
  const f = scopeFixture(child);
  writeFileSync(join(f.scope, "memory.max"), String(64 * 1024 ** 2));
  const monitor = new memory.NativeMemoryMonitor(child, f.roots);
  f.kill();
  expect(monitor.failure()).toMatchObject({
    limitBytes: 64 * 1024 ** 2,
    shared: false,
  });
  now = 11_000;
  expect(monitor.failure()).toBeUndefined();
  f.kill(2);
  expect(monitor.failure()).toBeInstanceOf(memory.NativeMemoryError);
});

function interceptScopes() {
  const original = memory.observeNativeMemory;
  const scopes = new Map<ChildProcess, ReturnType<typeof scopeFixture>>();
  vi.stubEnv("LOOP_NATIVE_LAUNCHER", "/usr/bin/env");
  vi.spyOn(memory, "observeNativeMemory").mockImplementation((child) => {
    const f = scopeFixture(child);
    scopes.set(child, f);
    original(child, f.roots);
  });
  return scopes;
}

it.skipIf(process.platform !== "linux").each([true, false])(
  "native RPC preserves confirmed memory evidence=%s without exposing stderr",
  async (confirmed) => {
    const scopes = interceptScopes();
    const native = new Native(
      process.execPath,
      [
        "-e",
        `process.stdin.resume(); process.stderr.write('secret-provider-token'); console.log('{"ready":true}');`,
      ],
      process.cwd(),
    );
    try {
      await once(native, "message");
      const failure = once(native, "failure");
      const pending = native.request("hold").catch((error) => error);
      if (confirmed) scopes.get(native.child)!.kill();
      native.child.kill("SIGKILL");
      const [error] = await failure;
      expect(await pending).toBe(error);
      if (confirmed) expect(error).toBeInstanceOf(memory.NativeMemoryError);
      else {
        expect(error).toBeInstanceOf(NativeTransportError);
        expect(error.code).toBe("native_process_exit");
        expect(error.message).not.toContain("Out of memory");
      }
      expect(JSON.stringify(error)).not.toContain("secret-provider-token");
    } finally {
      await native.dispose();
    }
  },
);

it
  .skipIf(process.platform !== "linux")
  .each(["codex", "claude", "pi", "opencode", "acp"] as const)(
  "%s exposes the memory diagnosis in the run's terminal status",
  async (harness) => {
    const scopes = interceptScopes();
    vi.stubEnv("LOOP_TEST_HARNESS", harness);
    const executable =
      harness === "acp" ? process.execPath : resolve("test/harness.mjs");
    if (harness !== "acp") chmodSync(executable, 0o755);
    const events: AdapterEvent[] = [];
    const Adapter = {
      codex: Codex,
      claude: Claude,
      pi: Pi,
      opencode: OpenCode,
      acp: Acp,
    }[harness];
    const adapter = new Adapter(
      {
        harness,
        project: process.cwd(),
        executable,
        ...(harness === "acp"
          ? { args: [resolve("test/fixtures/fake-acp.mjs"), "permission"] }
          : {}),
        billing: "existing",
        version: "fixture",
      },
      (event) => events.push(event),
    );
    try {
      await adapter.start();
      await adapter.prompt("wait");
      const [child, f] = [...scopes].find(
        ([child]) => child.exitCode === null && child.signalCode === null,
      )!;
      f.kill();
      child.kill("SIGTERM");
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) => event.type === "status" && event.status === "failed",
          ),
        ).toBe(true),
      );
      const event = events.find(
        (event) => event.type === "status" && event.status === "failed",
      );
      expect(event).toMatchObject({
        detail: expect.stringContaining("Out of memory."),
      });
      expect(JSON.stringify(event)).toContain("5 GiB, shared across agents");
      expect(JSON.stringify(event)).not.toMatch(
        /login|configuration|secret-provider-token/,
      );
    } finally {
      await adapter.dispose();
    }
  },
);
