import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedOpencodeHttp } from "../native/loopManaged";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function binding(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loop-opencode-http-"));
  dirs.push(dir);
  const path = join(dir, "launch.json");
  writeFileSync(
    path,
    JSON.stringify({ flavor: "opencode", generation: 3, ...overrides }),
  );
  vi.stubEnv("LOOP_MANAGED", "1");
  vi.stubEnv("LOOP_LAUNCH_FILE", path);
  vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "3");
}
it("gives each subprocess independent credentials matching its HTTP client", () => {
  binding();
  vi.stubEnv("OPENCODE_SERVER_PASSWORD", "host-credential");
  const a = managedOpencodeHttp()!;
  const b = managedOpencodeHttp()!;
  expect(a.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
  expect(a.env.OPENCODE_SERVER_PASSWORD).not.toBe(
    b.env.OPENCODE_SERVER_PASSWORD,
  );
  expect(
    Buffer.from(a.headers.Authorization.slice(6), "base64").toString(),
  ).toBe(`${a.env.OPENCODE_SERVER_USERNAME}:${a.env.OPENCODE_SERVER_PASSWORD}`);
  expect(process.env.OPENCODE_SERVER_PASSWORD).toBe("host-credential");
});
it.each([{ generation: 2 }, { flavor: "claude" }])(
  "refuses invalid launch bindings",
  (override) => {
    binding(override);
    expect(() => managedOpencodeHttp()).toThrow();
  },
);
it("leaves standalone HAPI authentication unchanged", () => {
  vi.stubEnv("LOOP_MANAGED", "0");
  expect(managedOpencodeHttp()).toBeUndefined();
});
