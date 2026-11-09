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
    provider: z.string().min(1),
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
