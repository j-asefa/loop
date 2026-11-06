import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { workspaceRoutes } from "../src/shared/workspace-api";

it("accounts for every production API registration through registry contracts", () => {
  const declared = new Set([
    ...Object.values(workspaceRoutes).map(
      (route) => `${route.method} ${route.path}`,
    ),
  ]);
  const seen = new Set<string>();
  const directory = mkdtempSync(join(tmpdir(), "loop-route-inventory-"));
  try {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "test/fixtures/legacy-route-inventory.ts"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("LOOP_"),
            ),
          ),
          NODE_ENV: "test",
          LOOP_PROFILE: "companion",
          LOOP_DATA_DIR: directory,
          LOOP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        },
      },
    );
    const marker = output
      .split("\n")
      .find((line) => line.startsWith("ROUTE_INVENTORY="));
    expect(marker, output).toBeDefined();
    const keys: string[] = JSON.parse(marker!.slice("ROUTE_INVENTORY=".length));
    const registered = new Set<string>();
    for (const key of keys) {
      expect(declared.has(key), `undeclared ${key}`).toBe(true);
      expect(registered.has(key), `duplicate ${key}`).toBe(false);
      registered.add(key);
      seen.add(key);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  expect([...seen].sort()).toEqual([...declared].sort());
}, 60_000);
