import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  VM_OPERATION_TRANSITIONS,
  VM_TRANSITIONS,
} from "../src/shared/vm-state";

const doc = readFileSync(
  new URL("../docs/state-machines.md", import.meta.url),
  "utf8",
);

function documented(heading: string) {
  // The pinned formatter pads table cells, so rows are found by their
  // leading pipe: a header, a rule, then one row per source state.
  const section = doc.split(heading)[1].split("\n##")[0];
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2);
  return Object.fromEntries(
    rows.map((line) => {
      const [, from, to] = line
        .split("|")
        .map((part) => part.trim().replaceAll(/[`*]/g, ""));
      return [from, to === "—" ? [] : to.split(" / ").sort()];
    }),
  );
}

const sorted = (edges: Record<string, readonly string[]>) =>
  Object.fromEntries(
    Object.entries(edges).map(([from, to]) => [from, [...to].sort()]),
  );

it("documents every experiment VM transition", () => {
  expect(documented("### `experiment_vms.state`")).toEqual(
    sorted(VM_TRANSITIONS),
  );
});

it("documents every VM operation transition", () => {
  expect(documented("### `vm_operations.state`")).toEqual(
    sorted(VM_OPERATION_TRANSITIONS),
  );
});
