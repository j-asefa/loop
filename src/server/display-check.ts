import { z } from "zod";
import {
  DISPLAY_COMPONENTS,
  DISPLAY_LIMITS,
  displayProblems,
  readDisplaySpec,
  type DisplayFailure,
} from "../shared/display-spec.js";

const components = DISPLAY_COMPONENTS.join(", ");
export const CHECK_DISPLAY_DESCRIPTION =
  "Loop draws fenced spec blocks in answers as displays. Components: " +
  components +
  '. Write one JSON Patch add per line to /root or /elements/<key>. Call this tool to check a block and get the full reference. It runs nothing and needs no approval. Example:\n{"op":"add","path":"/root","value":"summary"}\n{"op":"add","path":"/elements/summary","value":{"type":"Text","props":{"content":"Ready."}}}';

export const checkDisplaySchema = z.strictObject({
  // Allow room for an optional fence around a source at the renderer limit.
  spec: z.string().max(DISPLAY_LIMITS.source + 256),
});

const forms: Record<(typeof DISPLAY_COMPONENTS)[number], string> = {
  Card: "optional title and subtitle strings; children allowed",
  Section: "no props; children allowed",
  Text: 'nonempty Markdown content; optional style "plain", "bold" or "muted"',
  Fields: "no props; child Field keys",
  Field: "nonempty label and string or number value",
  Table:
    'nonempty string[] headers, (string | number)[][] rows; optional caption and align array of "left", "center" or "right"',
  Chart:
    'nonempty title and chart; pie uses {type:"pie",segments:[{label,value}]} with positive values; bar, line, or area uses {type,categories,series:[{name,values}],xLabel?,yLabel?} with string categories and numeric values',
  Divider: "no props",
  Actions: "no props; child LinkButton keys",
  LinkButton: "nonempty label and an HTTP(S) url",
};
const patchForm =
  "One JSON object per line with op add or replace. Use path /root with a string key, or /elements/<key> with an element object.";
const elementForm =
  "An element has type, optional props (defaults to {}), and optional children (element keys in order). Omit visible and repeat. Other fields and unknown props are ignored.";
const reference = [
  "Component reference",
  patchForm,
  "Later patches replace earlier values. Escape / as ~1 and ~ as ~0 in paths.",
  elementForm,
  ...DISPLAY_COMPONENTS.map((type) => `- ${type}: ${forms[type]}.`),
  `Limits: ${DISPLAY_LIMITS.source} source characters, ${DISPLAY_LIMITS.elements} element visits, depth ${DISPLAY_LIMITS.depth}, ${DISPLAY_LIMITS.tableRows} rows and ${DISPLAY_LIMITS.tableColumns} columns per table, ${DISPLAY_LIMITS.pieSegments} pie segments, ${DISPLAY_LIMITS.seriesCount} chart series and ${DISPLAY_LIMITS.categories} categories.`,
].join("\n");
const failures: Record<DisplayFailure, string> = {
  too_large: `Block exceeds ${DISPLAY_LIMITS.source} source characters. Shorten the block.`,
  empty: "Block has no applicable lines. " + patchForm,
  no_root: "/root is missing. Set it to the string key of a component.",
  missing_root:
    "/root points to a missing element. Define its key under /elements.",
  too_many_elements: `/root exceeds ${DISPLAY_LIMITS.elements} element visits. Reduce children and repeated references.`,
  too_deep: `/root exceeds depth ${DISPLAY_LIMITS.depth}. Flatten the children tree.`,
};

function displaySource(input: string) {
  const wrapped = input.trim().split(/\r\n?|\n/);
  const opener = /^(\x60{3,}|~{3,})[ \t]*(?:spec)?[ \t]*$/.exec(wrapped[0]);
  const closer = /^([\x60~]+)[ \t]*$/.exec(wrapped.at(-1) ?? "");
  if (
    opener &&
    closer &&
    wrapped.length > 1 &&
    closer[1].length >= opener[1].length &&
    [...closer[1]].every((character) => character === opener[1][0])
  )
    return wrapped.slice(1, -1).join("\n");
  return input.replace(/\r\n?/g, "\n");
}

export function checkDisplay(input: string): string {
  const display = readDisplaySpec(displaySource(input), {
    allSkippedLines: true,
  });
  const issues = display.skipped.map(
    ({ line, reason }) => `Line ${line}: ${reason}.`,
  );
  if (display.ok) {
    for (const problem of displayProblems(display.root)) {
      if (problem.type !== "Placeholder") continue;
      const form = Object.hasOwn(forms, problem.name)
        ? forms[problem.name as keyof typeof forms]
        : `Choose a component from ${components}`;
      issues.push(
        `Element ${JSON.stringify(problem.key)}: ${problem.detail}. ${elementForm} ${form}.`,
      );
    }
    if (!issues.length)
      return `Display valid. Elements: ${display.count}. To show it, write it in a fenced spec block in your answer or loop_reply body.`;
  } else issues.push(failures[display.reason]);
  return ["Display has problems.", ...issues, "", reference].join("\n");
}
