import { describe, expect, it } from "vitest";
import { piInventory } from "../src/adapters/pi-inventory";

describe("Pi customization inventory", () => {
  it("groups loaded package resources and keeps tools separate from actions", () => {
    const result = piInventory(
      [
        {
          name: "skill:review",
          token: "/skill:review",
          kind: "skill",
          description: "Review changes",
          sourceInfo: {
            origin: "package",
            baseDir: "/pi/packages/review",
            scope: "user",
          },
        },
        {
          name: "release",
          token: "/release",
          kind: "prompt",
          description: "Release notes",
          sourceInfo: { origin: "top-level", scope: "project" },
        },
      ],
      [
        {
          name: "inspect_diff",
          description: "Inspect diff",
          active: true,
          sourceInfo: { origin: "package", baseDir: "/pi/packages/review" },
        },
      ],
      {
        model: { provider: "openai", id: "gpt-5", name: "GPT 5" },
        thinkingLevel: "high",
      },
    );
    expect(result.packages).toEqual([
      { path: "/pi/packages/review", name: "review", resources: 2 },
    ]);
    expect(result.resources.map((r) => [r.kind, r.token, r.active])).toEqual([
      ["skill", "/skill:review", undefined],
      ["prompt", "/release", undefined],
      ["tool", undefined, true],
    ]);
    expect(result.model).toEqual({
      provider: "openai",
      id: "gpt-5",
      name: "GPT 5",
    });
  });
});
