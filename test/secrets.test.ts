import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const directory = mkdtempSync(join(tmpdir(), "loop-secrets-"));
vi.stubEnv("LOOP_DATA_DIR", directory);
const { seal, unseal } = await import("../src/server/secrets.js");
const keyPath = join(directory, "encryption-key");
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("uses the current environment key and authenticates the owning workspace", () => {
  const key = randomBytes(32).toString("hex");
  vi.stubEnv("LOOP_ENCRYPTION_KEY", key);
  const encrypted = seal("private fixture", "alice");
  expect(unseal(encrypted, "alice")).toBe("private fixture");
  expect(() => unseal(encrypted, "bob")).toThrow();
  expect(existsSync(keyPath)).toBe(false);
  vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  expect(() => unseal(encrypted, "alice")).toThrow();
  vi.stubEnv("LOOP_ENCRYPTION_KEY", key);
  expect(unseal(encrypted, "alice")).toBe("private fixture");
  vi.stubEnv("LOOP_ENCRYPTION_KEY", "invalid");
  expect(() => seal("fixture", "alice")).toThrow(/32 random bytes/);
});

it("reuses the private on-disk key when the environment key is absent", () => {
  vi.stubEnv("LOOP_ENCRYPTION_KEY", "");
  const first = seal("first", "alice");
  const key = readFileSync(keyPath, "utf8");
  expect(key).toMatch(/^[a-f\d]{64}$/);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  const second = seal("second", "alice");
  expect(readFileSync(keyPath, "utf8")).toBe(key);
  expect(unseal(first, "alice")).toBe("first");
  expect(unseal(second, "alice")).toBe("second");
  expect(() => unseal(second, "bob")).toThrow();
});
