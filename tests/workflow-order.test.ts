import { expect, it } from "vitest";
import { reorderSteps } from "../src/client/workflowOrder";

it("moves independent work without mutating the saved workflow", () => {
  const steps = [
    { id: "research" },
    { id: "check" },
    { id: "save", source: "research" },
  ];
  expect(reorderSteps(steps, 1, -1)?.map((s) => s.id)).toEqual([
    "check",
    "research",
    "save",
  ]);
  expect(steps.map((s) => s.id)).toEqual(["research", "check", "save"]);
  expect(reorderSteps(steps, 0, -1)).toBeNull();
  expect(reorderSteps(steps, 2, 1)).toBeNull();
});

it("keeps source and templated dependencies before their consumers", () => {
  const steps = [
    { id: "research" },
    { id: "check", prompt: "Review {{steps.research}}" },
    { id: "save", source: "check" },
  ];
  for (const [index, direction] of [
    [0, 1],
    [1, -1],
    [1, 1],
    [2, -1],
  ])
    expect(reorderSteps(steps, index, direction)).toBeNull();
  expect(
    reorderSteps([{ id: "a", source: "missing" }, { id: "b" }], 0, 1),
  ).toBeNull();
});
