import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RUN_TRANSITIONS } from "../src/shared/run-state";

it("documents every run transition, including states with no outgoing edges", () => {
  const doc = readFileSync(
    new URL("../docs/state-machines.md", import.meta.url),
    "utf8",
  );
  const section = doc.split("### `runs.state`")[1].split("\n## ")[0];
  const table = section
    .split("| From | To | Trigger and guard |")[1]
    .split("\n\n")[0];
  const rows = table
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [, from, to] = line.split("|").map((part) => part.trim());
      return [from, to === "—" ? [] : to.split(" / ").sort()] as const;
    });
  expect(rows).toHaveLength(Object.keys(RUN_TRANSITIONS).length);
  expect(Object.fromEntries(rows)).toEqual(
    Object.fromEntries(
      Object.entries(RUN_TRANSITIONS).map(([from, to]) => [
        from,
        [...to].sort(),
      ]),
    ),
  );
});
