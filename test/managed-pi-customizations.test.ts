import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { piCustomization } from "../src/native-auth/pi-customizations.js";

describe("managed Pi customization worker", () => {
  it("uses the worker's Pi home, applies project trust, and fences changed resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "loop-managed-pi-"));
    try {
      const project = join(root, "project");
      const agentDir = join(root, "runner-home", ".pi", "agent");
      mkdirSync(join(project, ".pi"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(project, ".pi", "settings.json"),
        JSON.stringify({ packages: ["npm:example"] }),
      );
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:personal"] }),
      );
      const context = {
        project,
        agentDir,
        executable: "/bin/false",
        environment: { HOME: join(root, "runner-home") },
      };
      const first: any = await piCustomization(
        { action: "configuration" },
        context,
      );
      expect(first.packages.map((p: any) => p.source)).toEqual([
        "npm:personal",
        "npm:example",
      ]);
      expect(first.trust.trusted).toBe(false);
      await piCustomization(
        {
          action: "trust",
          trusted: true,
          fingerprint: first.trust.fingerprint,
        },
        context,
      );
      expect(
        ((await piCustomization({ action: "configuration" }, context)) as any)
          .trust.trusted,
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"))[project],
      ).toBe(true);
      writeFileSync(
        join(project, ".pi", "settings.json"),
        JSON.stringify({ packages: ["npm:changed"] }),
      );
      const changed: any = await piCustomization(
        { action: "guard-trust" },
        context,
      );
      expect(changed.trust.trusted).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers commands from Pi RPC in the runner project and home", async () => {
    const root = mkdtempSync(join(tmpdir(), "loop-managed-pi-catalog-"));
    try {
      const project = join(root, "project");
      const home = join(root, "home");
      const executable = join(
        process.cwd(),
        "test",
        "fixtures",
        "pi-catalog.mjs",
      );
      mkdirSync(project);
      mkdirSync(home);
      const result: any = await piCustomization(
        { action: "catalog" },
        {
          project,
          agentDir: join(home, ".pi", "agent"),
          executable,
          environment: { HOME: home, PATH: process.env.PATH },
        },
      );
      expect(result.commands[0]).toMatchObject({
        name: "review",
        source: "prompt",
        sourceInfo: { scope: "project" },
      });
      expect(result.commands[0].sourceInfo.path).toBe(
        join(project, ".pi", "prompts", "review.md"),
      );
      expect(result.state.model).toMatchObject({
        provider: "fixture",
        id: "model",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
