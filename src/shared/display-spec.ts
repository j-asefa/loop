import { z } from "zod";

// Displays: a fenced `spec` block in an answer, drawn as structured UI. The
// format is a subset of json-render's inline format, read with Loop's own
// code. Once released, every block this reader accepts must keep reading the
// same way (handoff D8): later changes may only widen what is accepted.
//
// Each line inside the fence is one JSON Patch operation. Only `add` and
// `replace` on `/root` (a string) and `/elements/<key>` (a whole element) are
// applied; every other line is skipped and counted.

// Match the first language word used by the Markdown-to-HTML renderer after
// the parser has decoded character references in a fence's language token.
export function isDisplayFenceLanguage(language: string | null | undefined) {
  return language?.split(/\s+/, 1)[0] === "spec";
}

export const DISPLAY_LIMITS = {
  // Characters of block source.
  source: 65536,
  elements: 200,
  depth: 8,
  tableRows: 200,
  tableColumns: 20,
  // Table cells and chart values drawn across the whole display, counting
  // every reference to a shared element; a Table or Chart past it is a
  // placeholder.
  tableCells: 20000,
  // Characters of Text Markdown drawn across the display, counting every
  // reference to a shared Text; equal to the block limit, so only shared
  // references can reach it. A Text past it is a placeholder.
  textCharacters: 65536,
  // Characters of every string drawn across the display (titles, labels,
  // values, cells, Text), counting every reference to a shared element. Twice
  // the block limit, so only shared references can reach it. An element past
  // it is a placeholder.
  drawnCharacters: 131072,
  seriesCount: 12,
  categories: 200,
  pieSegments: 24,
  text: 4000,
  // Skipped lines reported in detail; the rest are only counted.
  skippedDetail: 50,
} as const;

const text = z.string().max(DISPLAY_LIMITS.text);
// Agents often emit numbers for display values; show them as text.
const shown = z.union([text, z.number()]).transform(String);
const alignment = z.enum(["left", "center", "right"]);
const httpUrl = z
  .string()
  .max(DISPLAY_LIMITS.text)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Links must be http or https URLs");

const pieChart = z.object({
  type: z.literal("pie"),
  segments: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        value: z.number().positive(),
      }),
    )
    .min(1)
    .max(DISPLAY_LIMITS.pieSegments),
});
const seriesChart = z.object({
  type: z.enum(["bar", "line", "area"]),
  categories: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(DISPLAY_LIMITS.categories),
  series: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        values: z.array(z.number()).max(DISPLAY_LIMITS.categories),
      }),
    )
    .min(1)
    .max(DISPLAY_LIMITS.seriesCount),
  xLabel: z.string().max(200).nullish(),
  yLabel: z.string().max(200).nullish(),
});
export const DisplayChartSchema = z.union([pieChart, seriesChart]);
export type DisplayChart = z.infer<typeof DisplayChartSchema>;

const replyText = text
  .min(1)
  .refine(
    (value) => !/^[ \t\r\n]*[@/!]/.test(value),
    "Reply prompts cannot start with @, /, or !",
  );

// Props of each catalog component. Unknown props are ignored.
const propSchemas = {
  Card: z.object({ title: text.nullish(), subtitle: text.nullish() }),
  Section: z.object({}),
  Text: z.object({
    content: z.string().min(1).max(DISPLAY_LIMITS.text),
    style: z.enum(["plain", "bold", "muted"]).nullish(),
  }),
  Fields: z.object({}),
  Field: z.object({ label: text.min(1), value: shown }),
  Table: z.object({
    headers: z.array(text).min(1).max(DISPLAY_LIMITS.tableColumns),
    rows: z.array(z.array(shown)).max(DISPLAY_LIMITS.tableRows),
    align: z.array(alignment).nullish(),
    caption: text.nullish(),
  }),
  Chart: z.object({ title: text.min(1), chart: DisplayChartSchema }),
  Divider: z.object({}),
  Actions: z.object({}),
  LinkButton: z.object({ label: text.min(1), url: httpUrl }),
  ReplyButton: z.object({
    label: replyText,
    prompt: replyText.nullish(),
  }),
};
const takesChildren = new Set(["Card", "Section", "Fields", "Actions"]);
export const DISPLAY_COMPONENTS = Object.keys(
  propSchemas,
) as (keyof typeof propSchemas)[];

export type DisplayAlign = z.infer<typeof alignment>;
export type DisplayNode =
  | {
      type: "Card";
      key: string;
      title: string | null;
      subtitle: string | null;
      children: DisplayNode[];
    }
  | { type: "Section"; key: string; children: DisplayNode[] }
  | {
      type: "Text";
      key: string;
      content: string;
      style: "plain" | "bold" | "muted";
    }
  | { type: "Fields"; key: string; children: DisplayNode[] }
  | { type: "Field"; key: string; label: string; value: string }
  | {
      type: "Table";
      key: string;
      headers: string[];
      rows: string[][];
      align: DisplayAlign[];
      caption: string | null;
    }
  | { type: "Chart"; key: string; title: string; chart: DisplayChart }
  | { type: "Divider"; key: string }
  | { type: "Actions"; key: string; children: DisplayNode[] }
  | { type: "LinkButton"; key: string; label: string; url: string }
  | {
      type: "ReplyButton";
      key: string;
      label: string;
      prompt: string | null;
    }
  | {
      type: "Placeholder";
      key: string;
      // The component the author named, trimmed for display.
      name: string;
      reason: "unsupported" | "invalid";
      // For agents (the check tool); readers see a fixed sentence.
      detail: string;
    };

export type DisplayFailure =
  | "too_large"
  | "empty"
  | "no_root"
  | "missing_root"
  | "too_many_elements"
  | "too_deep";
export type SkippedLine = { line: number; reason: string };
type Skips = { skipped: SkippedLine[]; skippedCount: number };
export type DisplayRead =
  | ({ ok: true; root: DisplayNode; count: number } & Skips)
  | ({ ok: false; reason: DisplayFailure } & Skips);

type RawElement = Record<string, unknown>;
type DisplayWarning = (key: string, detail: string) => void;

class DisplayLimit extends Error {
  constructor(readonly reason: DisplayFailure) {
    super(reason);
  }
}

const unescapePointer = (segment: string) =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const placeholder = (
  key: string,
  name: unknown,
  reason: "unsupported" | "invalid",
  detail: string,
): DisplayNode => ({
  type: "Placeholder",
  key,
  name: typeof name === "string" ? name.slice(0, 40) : "Element",
  reason,
  detail,
});

function build(
  key: string,
  type: string,
  props: unknown,
  children: DisplayNode[],
  onWarning?: DisplayWarning,
): DisplayNode | string {
  switch (type) {
    case "Card": {
      const p = propSchemas.Card.safeParse(props);
      return p.success
        ? {
            type,
            key,
            title: p.data.title ?? null,
            subtitle: p.data.subtitle ?? null,
            children,
          }
        : problem(p.error);
    }
    case "Section":
    case "Fields":
    case "Actions": {
      const p = propSchemas[type].safeParse(props);
      return p.success ? { type, key, children } : problem(p.error);
    }
    case "Text": {
      const p = propSchemas.Text.safeParse(props);
      return p.success
        ? { type, key, content: p.data.content, style: p.data.style ?? "plain" }
        : problem(p.error);
    }
    case "Field": {
      const p = propSchemas.Field.safeParse(props);
      return p.success
        ? { type, key, label: p.data.label, value: p.data.value }
        : problem(p.error);
    }
    case "Table": {
      const p = propSchemas.Table.safeParse(props);
      if (!p.success) return problem(p.error);
      const width = p.data.headers.length;
      if (onWarning)
        p.data.rows.forEach((row, index) => {
          if (row.length > width)
            onWarning(
              key,
              `Table row ${index + 1} has more cells (${row.length}) than headers (${width}). Add headers or remove the extra cells before publishing.`,
            );
        });
      return {
        type,
        key,
        headers: p.data.headers,
        // Short rows are padded and extra cells dropped.
        rows: p.data.rows.map((row) =>
          Array.from({ length: width }, (_, i) => row[i] ?? ""),
        ),
        align: Array.from(
          { length: width },
          (_, i) => p.data.align?.[i] ?? "left",
        ),
        caption: p.data.caption ?? null,
      };
    }
    case "Chart": {
      const p = propSchemas.Chart.safeParse(props);
      return p.success
        ? { type, key, title: p.data.title, chart: p.data.chart }
        : problem(p.error);
    }
    case "Divider": {
      const p = propSchemas.Divider.safeParse(props);
      return p.success ? { type, key } : problem(p.error);
    }
    case "LinkButton": {
      const p = propSchemas.LinkButton.safeParse(props);
      // Draw the parsed URL, so the href is the one that was checked:
      // `https:example.com` would otherwise resolve against Loop's own page.
      return p.success
        ? { type, key, label: p.data.label, url: new URL(p.data.url).href }
        : problem(p.error);
    }
    case "ReplyButton": {
      const p = propSchemas.ReplyButton.safeParse(props);
      return p.success
        ? {
            type,
            key,
            label: p.data.label,
            prompt: p.data.prompt ?? null,
          }
        : problem(p.error);
    }
    default:
      return "";
  }
}

function problem(error: z.ZodError): string {
  const first = error.issues[0];
  const where = first?.path.length ? first.path.join(".") + ": " : "";
  return where + (first?.message ?? "Invalid props");
}

function draw(
  key: string,
  elements: Map<string, RawElement>,
  path: Set<string>,
  depth: number,
  state: {
    count: number;
    cells: number;
    text: number;
    drawn: number;
    omitMissing: boolean;
    onWarning?: DisplayWarning;
    tablesAndCharts?: Map<string, DisplayNode | string>;
  },
): DisplayNode {
  if (depth > DISPLAY_LIMITS.depth) throw new DisplayLimit("too_deep");
  if (++state.count > DISPLAY_LIMITS.elements)
    throw new DisplayLimit("too_many_elements");
  const element = elements.get(key);
  if (!element)
    return placeholder(key, "Element", "invalid", `No element named "${key}"`);
  if (path.has(key))
    return placeholder(
      key,
      element.type,
      "invalid",
      `"${key}" contains itself`,
    );
  const type = element.type;
  if (typeof type !== "string" || !Object.hasOwn(propSchemas, type))
    return placeholder(
      key,
      type,
      "unsupported",
      typeof type === "string"
        ? `Unsupported component "${type.slice(0, 40)}"`
        : "Element has no type",
    );
  if ("visible" in element || "repeat" in element)
    return placeholder(
      key,
      type,
      "unsupported",
      "visible and repeat are not supported",
    );
  const hasChildren = takesChildren.has(type);
  const children = element.children ?? [];
  const list = hasChildren ? children : [];
  if (!hasChildren && (!Array.isArray(children) || children.length > 0))
    state.onWarning?.(
      key,
      `${type} does not draw children. Move them into a component that accepts children, such as Card or Section.`,
    );
  if (!Array.isArray(list) || !list.every((k) => typeof k === "string"))
    return placeholder(
      key,
      type,
      "invalid",
      "children must be a list of element keys",
    );
  // Props are checked before children are visited, so an invalid container
  // is one placeholder and its children count toward no limit.
  // The checker can reuse validated tables and charts, which have no
  // per-visit children. Every visit still charges the display budgets.
  let built = state.tablesAndCharts?.get(key);
  if (built === undefined) {
    built = build(key, type, element.props ?? {}, [], state.onWarning);
    if (type === "Table" || type === "Chart")
      state.tablesAndCharts?.set(key, built);
  }
  if (typeof built === "string")
    return placeholder(key, type, "invalid", built);
  // An element drawn as a placeholder charges none of the budgets.
  // Tables charge their cells; charts charge the marks they draw (and the
  // matching rows of their table of numbers).
  const cells =
    built.type === "Table"
      ? built.rows.length * built.headers.length
      : built.type === "Chart"
        ? built.chart.type === "pie"
          ? built.chart.segments.length
          : built.chart.series.length * built.chart.categories.length
        : 0;
  if (state.cells + cells > DISPLAY_LIMITS.tableCells)
    return placeholder(
      key,
      type,
      "invalid",
      `The display has more than ${DISPLAY_LIMITS.tableCells} table cells and chart values`,
    );
  const text = built.type === "Text" ? built.content.length : 0;
  if (state.text + text > DISPLAY_LIMITS.textCharacters)
    return placeholder(
      key,
      type,
      "invalid",
      `The display has more than ${DISPLAY_LIMITS.textCharacters} characters of Text`,
    );
  const drawn = drawnLength(built);
  if (state.drawn + drawn > DISPLAY_LIMITS.drawnCharacters)
    return placeholder(
      key,
      type,
      "invalid",
      `The display has more than ${DISPLAY_LIMITS.drawnCharacters} characters`,
    );
  state.cells += cells;
  state.text += text;
  state.drawn += drawn;
  if ("children" in built) {
    path.add(key);
    built.children = list.flatMap((child) => {
      // Pending references still count toward the same limits as placeholders.
      const drawnChild = draw(child, elements, path, depth + 1, state);
      return state.omitMissing && !elements.has(child) ? [] : [drawnChild];
    });
    path.delete(key);
  }
  return built;
}

// Characters an element draws itself, not counting its children.
function drawnLength(node: DisplayNode): number {
  const sum = (values: (string | null)[]) =>
    values.reduce((total, value) => total + (value?.length ?? 0), 0);
  switch (node.type) {
    case "Card":
      return sum([node.title, node.subtitle]);
    case "Text":
      return node.content.length;
    case "Field":
      return sum([node.label, node.value]);
    case "Table":
      return sum([node.caption, ...node.headers, ...node.rows.flat()]);
    case "Chart":
      return (
        node.title.length +
        (node.chart.type === "pie"
          ? sum(node.chart.segments.map((segment) => segment.label))
          : sum([
              ...node.chart.categories,
              ...node.chart.series.map((series) => series.name),
              node.chart.xLabel ?? null,
              node.chart.yLabel ?? null,
            ]))
      );
    case "LinkButton":
      return sum([node.label, node.url]);
    case "ReplyButton":
      return sum([node.label, node.prompt]);
    default:
      return 0;
  }
}

export type DisplayReadOptions = {
  // The fence has not closed. While writing, its final line may be incomplete.
  open?: boolean;
  // The block is still being written: children whose elements have not
  // arrived are left out instead of drawn as placeholders.
  writing?: boolean;
  finalLineIncomplete?: boolean;
  allSkippedLines?: boolean;
  onWarning?: DisplayWarning;
};

// Reads the text inside a `spec` fence; by default the block is complete.
export function readDisplaySpec(
  source: string,
  {
    open = false,
    writing = false,
    finalLineIncomplete = false,
    allSkippedLines = false,
    onWarning,
  }: DisplayReadOptions = {},
): DisplayRead {
  const skips: Skips = { skipped: [], skippedCount: 0 };
  const skip = (line: number, reason: string) => {
    skips.skippedCount++;
    if (allSkippedLines || skips.skipped.length < DISPLAY_LIMITS.skippedDetail)
      skips.skipped.push({ line, reason });
  };
  if (source.length > DISPLAY_LIMITS.source)
    return { ok: false, reason: "too_large", ...skips };
  let root: string | undefined;
  const elements = new Map<string, RawElement>();
  let applied = 0;
  const all = source.split("\n");
  all.forEach((raw, index) => {
    if (finalLineIncomplete && index === all.length - 1) return;
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    let patch: unknown;
    try {
      patch = JSON.parse(trimmed);
    } catch {
      if (open && writing && index === all.length - 1) return;
      return skip(line, "Not valid JSON");
    }
    if (!isObject(patch)) return skip(line, "Not a JSON object");
    if (patch.op !== "add" && patch.op !== "replace")
      return skip(line, "Only add and replace are supported");
    const path = patch.path;
    if (path === "/root") {
      if (typeof patch.value !== "string")
        return skip(line, "/root must be a string");
      root = patch.value;
      applied++;
      return;
    }
    const parts = typeof path === "string" ? path.split("/") : [];
    if (
      parts.length === 3 &&
      parts[0] === "" &&
      parts[1] === "elements" &&
      parts[2]
    ) {
      if (!isObject(patch.value))
        return skip(line, "An element must be an object");
      elements.set(unescapePointer(parts[2]), patch.value);
      applied++;
      return;
    }
    skip(line, "Only /root and /elements/<key> are supported");
  });
  if (!applied) return { ok: false, reason: "empty", ...skips };
  if (root === undefined) return { ok: false, reason: "no_root", ...skips };
  if (!elements.has(root))
    return { ok: false, reason: "missing_root", ...skips };
  const state = {
    count: 0,
    cells: 0,
    text: 0,
    drawn: 0,
    omitMissing: open && writing,
    onWarning,
    tablesAndCharts: onWarning
      ? new Map<string, DisplayNode | string>()
      : undefined,
  };
  try {
    return {
      ok: true,
      root: draw(root, elements, new Set(), 1, state),
      count: state.count,
      ...skips,
    };
  } catch (error) {
    if (error instanceof DisplayLimit)
      return { ok: false, reason: error.reason, ...skips };
    throw error;
  }
}

// Every placeholder in a tree, for agents. Readers see fixed sentences.
export function displayProblems(node: DisplayNode): DisplayNode[] {
  if (node.type === "Placeholder") return [node];
  return "children" in node ? node.children.flatMap(displayProblems) : [];
}
