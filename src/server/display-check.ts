import { z } from "zod";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  DISPLAY_COMPONENTS,
  DISPLAY_LIMITS,
  isDisplayFenceLanguage,
  readDisplaySpec,
  type DisplayFailure,
  type DisplayNode,
} from "../shared/display-spec.js";
import { PUBLISHED_REPLY_BODY_LIMIT } from "../shared/steering-replies.js";

const components = DISPLAY_COMPONENTS.join(", ");
export const CHECK_DISPLAY_DESCRIPTION =
  "Loop draws fenced spec blocks in answers as displays. Components: " +
  components +
  '. Write one JSON Patch add per line to /root or /elements/<key>. Call this tool to check a block and get the full reference. It runs nothing and needs no approval. Example:\n{"op":"add","path":"/root","value":"summary"}\n{"op":"add","path":"/elements/summary","value":{"type":"Text","props":{"content":"Ready."}}}';

export const checkDisplaySchema = z.strictObject({
  spec: z.string(),
});
const markdown = unified().use(remarkParse).freeze();
// Allow three spaces of fence indentation per line, CRLF and the wrapper.
const MAX_DISPLAY_INPUT = 5 * DISPLAY_LIMITS.source + 256;

const forms: Record<(typeof DISPLAY_COMPONENTS)[number], string> = {
  Card: "optional title and subtitle strings; children allowed",
  Section: "no props; children allowed",
  Text: 'nonempty Markdown content; optional style "plain", "bold" or "muted"',
  Fields: "no props; child Field keys",
  Field: "nonempty label and string or number value",
  Table:
    'nonempty string[] headers, (string | number)[][] rows; optional caption and align array of "left", "center" or "right"',
  Chart:
    'nonempty title and chart; pie uses {type:"pie",segments:[{label,value}]} with positive values; bar, line, or area uses {type,categories,series:[{name,values}],xLabel?,yLabel?} with string categories and at most one numeric value per category in each series',
  Divider: "no props",
  Actions: "no props; children allowed, typically LinkButton elements",
  LinkButton: "nonempty label and an HTTP(S) url",
};
const patchForm =
  "One JSON object per line with op add or replace. Use path /root with a string key, or /elements/<key> with an element object.";
const elementForm =
  "An element has type and optional props (defaults to {}). Supply children (element keys in order) only for Card, Section, Fields, and Actions. Omit visible and repeat. Other fields and unknown props are ignored.";
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
  // Remark strips a leading BOM before identifying Markdown blocks.
  const lines = input.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const first = lines.findIndex((line) => /[^ \t]/.test(line));
  if (/^ {0,3}(\x60{3,}|~{3,})/.test(lines[first] ?? "")) {
    // Markdown preserves internal line endings and removes fence indentation.
    const { children } = markdown.parse(input);
    const node = children[0];
    if (
      children.length !== 1 ||
      node?.type !== "code" ||
      !isDisplayFenceLanguage(node.lang)
    )
      return {
        issue: `Line ${first + 1}: Use a single fenced block with spec as the fenced block's language.`,
      };
    return { source: node.value };
  }
  return { source: input };
}

// Leave room for the failure summary and reference within the API runtime's
// ordinary tool result limit, including when diagnostics reflect caller text.
const DIAGNOSTIC_BUDGET = 8_000;
const quotedDiagnostic = (value: string) =>
  JSON.stringify(value.length > 160 ? value.slice(0, 159) + "…" : value);

export function checkDisplay(input: string): string {
  if (input.length > MAX_DISPLAY_INPUT)
    return [failures.too_large, "", reference].join("\n");
  const source = displaySource(input);
  if (source.issue !== undefined)
    return [source.issue, "", reference].join("\n");
  const issues: string[] = [];
  let remaining = DIAGNOSTIC_BUDGET;
  let omitted = 0;
  const add = (issue: string) => {
    if (issue.length + 1 > remaining) {
      omitted++;
      return;
    }
    remaining -= issue.length + 1;
    issues.push(issue);
  };
  const warnings = new Map<string, Set<string>>();
  const display = readDisplaySpec(source.source, {
    allSkippedLines: true,
    onWarning(key, detail) {
      const details = warnings.get(key) ?? new Set<string>();
      if (details.has(detail)) return;
      details.add(detail);
      warnings.set(key, details);
      add(`Element ${quotedDiagnostic(key)}: ${detail}`);
    },
  });
  for (const { line, reason } of display.skipped)
    add(`Line ${line}: ${reason}.`);
  if (display.ok) {
    const visit = (node: DisplayNode) => {
      if (node.type === "Placeholder") {
        const form = Object.hasOwn(forms, node.name)
          ? forms[node.name as keyof typeof forms]
          : `Choose a component from ${components}`;
        add(
          `Element ${quotedDiagnostic(node.key)}: ${quotedDiagnostic(node.detail)}. ${elementForm} ${form}.`,
        );
      } else if (node.type === "Chart" && node.chart.type !== "pie") {
        const { categories, series } = node.chart;
        for (const { name, values } of series)
          if (values.length > categories.length)
            add(
              `Element ${quotedDiagnostic(node.key)}: Chart series ${quotedDiagnostic(name)} has more values (${values.length}) than categories (${categories.length}). Add categories or remove the extra values before publishing.`,
            );
      } else if ("children" in node) {
        for (const child of node.children) {
          if (
            node.type === "Fields" &&
            child.type !== "Field" &&
            child.type !== "Placeholder"
          )
            add(
              `Element ${quotedDiagnostic(node.key)}: Fields expects Field children. Move ${quotedDiagnostic(child.key)} (${child.type}) to a Card or Section, or use a Field here.`,
            );
          visit(child);
        }
      }
    };
    visit(display.root);
    if (!issues.length)
      return `Display valid. Elements: ${display.count}. Put it in a fenced spec block in your answer. You can also use a loop_reply body if the entire reply, including the fence, fits within ${PUBLISHED_REPLY_BODY_LIMIT} characters.`;
  }
  const summary = display.ok
    ? "Display has problems."
    : failures[display.reason];
  if (omitted)
    issues.push(
      `${omitted} additional diagnostics omitted. Fix the listed issues and check the block again.`,
    );
  return [summary, ...issues, "", reference].join("\n");
}
