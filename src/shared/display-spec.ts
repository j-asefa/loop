import { z } from "zod";

// Displays: a fenced `spec` block in an answer, drawn as structured UI. The
// format is a subset of json-render's inline format, read with Loop's own
// code. Once released, every block this reader accepts must keep reading the
// same way (handoff D8): later changes may only widen what is accepted.
//
// Each line inside the fence is one JSON Patch operation. Only `add` and
// `replace` on `/root` (a string) and `/elements/<key>` (a whole element) are
// applied; every other line is skipped and counted.

export const DISPLAY_LIMITS = {
  // Characters of block source.
  source: 65536,
  elements: 200,
  depth: 8,
  tableRows: 200,
  tableColumns: 20,
  // Table cells drawn across the whole display, counting every reference to
  // a shared table; a Table past it is a placeholder.
  tableCells: 20000,
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
};
const takesChildren = new Set(["Card", "Section", "Fields", "Actions"]);

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
  state: { count: number; cells: number },
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
  let kids: DisplayNode[] = [];
  if (takesChildren.has(type) && element.children !== undefined) {
    const list = element.children;
    if (!Array.isArray(list) || !list.every((k) => typeof k === "string"))
      return placeholder(
        key,
        type,
        "invalid",
        "children must be a list of element keys",
      );
    path.add(key);
    kids = list.map((child) => draw(child, elements, path, depth + 1, state));
    path.delete(key);
  }
  const built = build(key, type, element.props ?? {}, kids);
  if (typeof built === "string")
    return placeholder(key, type, "invalid", built);
  if (built.type === "Table") {
    state.cells += built.rows.length * built.headers.length;
    if (state.cells > DISPLAY_LIMITS.tableCells)
      return placeholder(
        key,
        type,
        "invalid",
        `The display has more than ${DISPLAY_LIMITS.tableCells} table cells`,
      );
  }
  return built;
}

// Reads the text inside a `spec` fence. The block is treated as complete.
export function readDisplaySpec(source: string): DisplayRead {
  const skips: Skips = { skipped: [], skippedCount: 0 };
  const skip = (line: number, reason: string) => {
    skips.skippedCount++;
    if (skips.skipped.length < DISPLAY_LIMITS.skippedDetail)
      skips.skipped.push({ line, reason });
  };
  if (source.length > DISPLAY_LIMITS.source)
    return { ok: false, reason: "too_large", ...skips };
  let root: string | undefined;
  const elements = new Map<string, RawElement>();
  let applied = 0;
  source.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    let patch: unknown;
    try {
      patch = JSON.parse(trimmed);
    } catch {
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
  const state = { count: 0, cells: 0 };
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
