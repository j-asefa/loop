import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { workspaceRoutes } from "../src/shared/workspace-api";

// Failure text names the rule and the route recipe.
const routeRecipe = "docs/contracts.md#recipe-add-a-workspace-route";
const undeclared = (key: string) =>
  `${key} is mounted on the server but declared by no workspace contract. Declare it with endpoint() in src/shared/<feature>-routes.ts and register it through the registrar (${routeRecipe}). If this can't be satisfied, say so in the PR.`;
const duplicate = (key: string) =>
  `${key} is registered more than once. Register each contract once, through its feature's registrar (${routeRecipe}).`;

it("names the route recipe in registration failures", () => {
  expect(undeclared("GET /probe")).toBe(
    "GET /probe is mounted on the server but declared by no workspace contract. Declare it with endpoint() in src/shared/<feature>-routes.ts and register it through the registrar (docs/contracts.md#recipe-add-a-workspace-route). If this can't be satisfied, say so in the PR.",
  );
  expect(duplicate("GET /probe")).toBe(
    "GET /probe is registered more than once. Register each contract once, through its feature's registrar (docs/contracts.md#recipe-add-a-workspace-route).",
  );
});

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
      expect(declared.has(key), undeclared(key)).toBe(true);
      expect(registered.has(key), duplicate(key)).toBe(false);
      registered.add(key);
      seen.add(key);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(
    [...seen].sort(),
    `Declared contracts must each be mounted through a registrar (${routeRecipe})`,
  ).toEqual([...declared].sort());
}, 60_000);
