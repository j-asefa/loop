import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "loop-runtime-discovery-"));
process.env.LOOP_DATA_DIR = root;
const probe = vi.hoisted(() => vi.fn());
vi.mock("../src/host-control.js", () => ({ discover: probe }));
const { db } = await import("../src/server/db");
const { runtimeList } = await import("../src/server/execution-runtime-actions");
afterAll(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it("refreshes and an expired cache share a pending probe, then cache from completion", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  probe.mockImplementation((name: string) =>
    name === "gemini"
      ? pending
      : Promise.resolve({ name, installed: false, help: "fixture" }),
  );
  const original = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(original);
  const first = runtimeList({ fresh: true });
  const refresh = runtimeList({ fresh: true });
  clock.mockReturnValue(original + 20000);
  const expired = runtimeList({ fresh: false });
  const calls = () => probe.mock.calls.filter(([name]) => name === "gemini");
  expect(calls()).toHaveLength(1);
  finish({
    name: "gemini",
    installed: true,
    supported: true,
    version: "0.65.0",
    help: "",
  });
  const results = await Promise.all([first, refresh, expired]);
  expect(
    results.every(
      (r) => r.runtimes.find((h) => h.name === "gemini")?.version === "0.65.0",
    ),
  ).toBe(true);
  clock.mockReturnValue(original + 25000);
  await runtimeList({ fresh: false });
  expect(calls()).toHaveLength(1);
  await runtimeList({ fresh: true });
  expect(calls()).toHaveLength(2);
  clock.mockRestore();
});
