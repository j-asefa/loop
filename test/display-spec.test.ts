import { expect, it } from "vitest";
import {
  DISPLAY_LIMITS,
  displayProblems,
  readDisplaySpec,
} from "../src/shared/display-spec";
import { displayFixtures, summarize } from "./display-spec-fixtures";

it("keeps fixture names unique so none is silently replaced", () => {
  const names = displayFixtures.map((fixture) => fixture.name);
  expect(new Set(names).size).toBe(names.length);
});

for (const fixture of displayFixtures)
  it(`reads: ${fixture.name}`, () => {
    const read = readDisplaySpec(fixture.source, {
      open: !!fixture.open,
      writing: fixture.open === "writing",
    });
    expect(summarize(read)).toEqual(fixture.expect);
    expect(read.skippedCount).toBe(fixture.skipped ?? 0);
  });

it("reports each skipped line with its number and a reason", () => {
  const read = readDisplaySpec(
    [
      '{"op":"add","path":"/root","value":"d"}',
      "oops",
      '{"op":"add","path":"/elements/d","value":{"type":"Divider"}}',
      '{"op":"add","path":"/state/a","value":1}',
    ].join("\n"),
  );
  expect(read.skipped).toEqual([
    { line: 2, reason: "Not valid JSON" },
    { line: 4, reason: "Only /root and /elements/<key> are supported" },
  ]);
});

it("counts every skipped line but details only the first fifty", () => {
  const junk = Array.from({ length: 80 }, () => "junk").join("\n");
  const read = readDisplaySpec(
    junk + '\n{"op":"add","path":"/root","value":"x"}',
  );
  expect(read.skippedCount).toBe(80);
  expect(read.skipped).toHaveLength(DISPLAY_LIMITS.skippedDetail);
});

it("lists placeholders with a detail an agent can act on", () => {
  const read = readDisplaySpec(
    [
      '{"op":"add","path":"/root","value":"s"}',
      '{"op":"add","path":"/elements/s","value":{"type":"Section","children":["g","f"]}}',
      '{"op":"add","path":"/elements/g","value":{"type":"Gauge"}}',
      '{"op":"add","path":"/elements/f","value":{"type":"Field","props":{"label":"x"}}}',
    ].join("\n"),
  );
  if (!read.ok) throw new Error("expected a drawable display");
  expect(
    displayProblems(read.root).map(
      (p) => p.type === "Placeholder" && [p.key, p.reason, p.detail],
    ),
  ).toEqual([
    ["g", "unsupported", 'Unsupported component "Gauge"'],
    ["f", "invalid", "value: Invalid input"],
  ]);
});

it("never throws on hostile input", () => {
  const nest = "[".repeat(20000);
  const inputs = [
    nest,
    `{"op":"add","path":"/root","value":"a"}\n{"op":"add","path":"/elements/a","value":{"type":"Section","children":${nest}}}`,
    '{"op":"add","path":"/root","value":"__proto__"}\n{"op":"add","path":"/elements/__proto__","value":{"type":"Divider"}}',
    '{"op":"add","path":"/root","value":"constructor"}\n{"op":"add","path":"/elements/constructor","value":{"type":"toString"}}',
    "\u0000�".repeat(100),
    '{"op":"add","path":"/elements/a/b/c","value":{}}',
  ];
  for (const input of inputs)
    expect(() => readDisplaySpec(input)).not.toThrow();
  const proto = readDisplaySpec(inputs[2]);
  expect(proto.ok && proto.root.type).toBe("Divider");
  expect(({} as Record<string, unknown>).type).toBeUndefined();
});
