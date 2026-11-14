import Database from "better-sqlite3";
import { applyMigrations } from "../src/server/migrations.js";
import { ProviderSchema } from "../src/shared/provider-schema.js";
import { Provider } from "../src/server/sql/rows.js";
import { classes } from "../src/server/native/adapters.js";
import { workspaceMcp } from "../src/adapters/workspace-mcp.js";
import { launchPermissionMode } from "../src/shared/permission-modes.js";
import { cliDriver } from "../src/native-auth/cli.js";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  harnesses,
  Harness,
  RuntimeHarness,
  ManagedHarness,
  nativeConnectionId,
} from "../src/shared/harnesses.js";

it("every registered harness supplies complete browser-safe discovery and policy facts", () => {
  const descriptor = z.strictObject({
    label: z.string().min(1),
    executable: z.string().min(1).nullable(),
    minimumVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .nullable(),
    installUrl: z.url().nullable(),
    runtime: z.boolean(),
    billing: z.strictObject({
      default: z.enum(["existing", "subscription"]),
      subscription: z.boolean(),
      cliConsent: z.boolean(),
    }),
    upgrade: z.strictObject({
      package: z.string().nullable(),
      brew: z.array(z.string()),
      selfUpdating: z.string().nullable(),
    }),
    environment: z.record(z.string(), z.string()),
    managed: z.boolean(),
    workspaceTools: z.boolean(),
    agentMail: z.boolean(),
    midTurn: z.enum(["steer", "queue"]),
    provider: ProviderSchema,
    activityTransport: z.enum(["native", "acp"]),
    launchPermissionMode: z.boolean(),
    cliSignIn: z
      .strictObject({
        provider: z.strictObject({ id: z.string(), name: z.string() }),
        methods: z
          .array(
            z.strictObject({
              id: z.string(),
              type: z.literal("oauth"),
              label: z.string(),
              args: z.array(z.string()),
            }),
          )
          .min(1),
        defaultArgs: z.array(z.string()).min(1),
        response: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("device-code") }),
          z.strictObject({
            kind: z.literal("manual-code"),
            prompt: z.string(),
          }),
        ]),
        domains: z
          .array(z.strictObject({ name: z.string(), subdomains: z.boolean() }))
          .min(1),
      })
      .nullable(),
    importWorktree: z.boolean(),
    history: z.string().min(1),
  });
  expect(Object.keys(harnesses)).not.toHaveLength(0);
  for (const [id, facts] of Object.entries(harnesses)) {
    expect(descriptor.safeParse(facts).success, id).toBe(true);
    expect(Harness.parse(id)).toBe(id);
    if (facts.runtime) {
      expect(facts.executable).toBeTruthy();
      expect(facts.minimumVersion).toBeTruthy();
      expect(facts.installUrl).toBeTruthy();
    }
  }
  expect(RuntimeHarness.safeParse("acp").success).toBe(false);
  expect(ManagedHarness.safeParse("codex").success).toBe(false);
  expect(ManagedHarness.parse("pi")).toBe("pi");
  expect(Harness.safeParse("toString").success).toBe(false);
  expect(nativeConnectionId("claude")).toBe("native-claude");
});

it("the Docker provider selection matches the bundled harness descriptors", () => {
  const dockerfile = readFileSync(
    new URL("../Dockerfile.companion", import.meta.url),
    "utf8",
  );
  const command = JSON.parse(dockerfile.match(/^CMD (.*)$/m)![1]) as string[];
  const selected = command[command.indexOf("--providers") + 1].split(",");
  const bundled = Object.entries(harnesses)
    .filter(([, facts]) => facts.upgrade.package)
    .map(([name]) => name);
  expect(selected.sort()).toEqual(bundled.sort());
  const packages = JSON.parse(
    readFileSync(
      new URL("../deployment/native/package.json", import.meta.url),
      "utf8",
    ),
  ).dependencies;
  for (const name of bundled)
    expect(
      packages[harnesses[Harness.parse(name)].upgrade.package!],
    ).toBeTruthy();
});

it("derived policy and adapter tables cover every declared harness", async () => {
  const encodings = workspaceMcp({
    url: "http://127.0.0.1/tools",
    token: "fixture",
  });
  expect(Object.keys(encodings).sort()).toEqual(
    Object.entries(harnesses)
      .filter(([, h]) => h.workspaceTools)
      .map(([id]) => id)
      .sort(),
  );
  expect(encodings.grok).toBe(encodings.acp);
  expect(Provider).toBe(ProviderSchema);
  for (const id of Harness.options) {
    const facts = harnesses[id];
    expect(ProviderSchema.parse(facts.provider)).toBe(facts.provider);
    expect(
      typeof Reflect.get(classes[id].prototype, "steer") === "function",
      id,
    ).toBe(facts.midTurn === "steer");
    expect(launchPermissionMode(id, "bypassPermissions"), id).toBe(
      facts.launchPermissionMode ? "bypassPermissions" : "default",
    );
    if (facts.cliSignIn) {
      const driver = cliDriver({
        name: id,
        executable: "unused",
        project: ".",
      });
      expect(await driver.providers()).toEqual([
        {
          ...facts.cliSignIn.provider,
          methods: facts.cliSignIn.methods.map(({ id, type, label }) => ({
            id,
            type,
            label,
          })),
        },
      ]);
      await driver.dispose();
    }
  }
  expect(launchPermissionMode("unknown", "bypassPermissions")).toBe("default");
});

it("the migrated connections CHECK agrees with providers except named retired values", () => {
  // Owner-approved historical exception: immutable migration134 still permits
  // gemini. Runtime providers must keep rejecting it; remove this exception
  // if a separately authorized migration removes it from the CHECK.
  const retired = new Map([
    [
      "gemini",
      "Retired provider retained by migration134; not a runtime provider.",
    ],
  ]);
  const db = new Database(":memory:");
  try {
    applyMigrations(db);
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='connections'",
      )
      .get() as { sql: string };
    const clause = row.sql.match(/CHECK\s*\(provider IN \(([^)]+)\)\)/i);
    expect(clause).not.toBeNull();
    const stored = [...clause![1].matchAll(/'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(stored.filter((name) => !retired.has(name)).sort()).toEqual(
      [...ProviderSchema.options].sort(),
    );
    expect(
      stored.filter((name) => !ProviderSchema.safeParse(name).success).sort(),
    ).toEqual([...retired.keys()].sort());
    for (const name of retired.keys())
      expect(ProviderSchema.safeParse(name).success).toBe(false);
  } finally {
    db.close();
  }
});
