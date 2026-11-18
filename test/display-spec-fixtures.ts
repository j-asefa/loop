import {
  DISPLAY_LIMITS,
  type DisplayFailure,
  type DisplayNode,
  type DisplayRead,
} from "../src/shared/display-spec";

// Frozen record of what the display reader must produce for each block
// (handoff D8). Later changes may append entries; an existing entry is never
// edited or removed, because blocks like these are stored in sealed answers
// and must keep reading the same way forever.

export type DisplayFixture = {
  name: string;
  source: string;
  // The outline of the drawn tree, or the reason the block can't be drawn.
  expect: { outline: string[] } | { fails: DisplayFailure };
  // Lines the reader skipped. Omitted means none.
  skipped?: number;
};

export function outline(node: DisplayNode, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const json = (value: unknown) => JSON.stringify(value);
  const kids = (children: DisplayNode[]) =>
    children.flatMap((child) => outline(child, depth + 1));
  switch (node.type) {
    case "Card":
      return [
        pad +
          "Card" +
          (node.title !== null ? ` title=${json(node.title)}` : "") +
          (node.subtitle !== null ? ` subtitle=${json(node.subtitle)}` : ""),
        ...kids(node.children),
      ];
    case "Section":
    case "Fields":
    case "Actions":
      return [pad + node.type, ...kids(node.children)];
    case "Divider":
      return [pad + "Divider"];
    case "Text":
      return [
        `${pad}Text style=${node.style} ${json(node.content.slice(0, 60))} len=${node.content.length}`,
      ];
    case "Field":
      return [`${pad}Field ${json(node.label)}=${json(node.value)}`];
    case "Table":
      return [
        `${pad}Table headers=${json(node.headers)} align=${json(node.align)} caption=${json(node.caption)} rows=${node.rows.length} first=${json(node.rows[0] ?? null)} last=${json(node.rows.at(-1) ?? null)}`,
      ];
    case "Chart":
      return [
        `${pad}Chart ${json(node.title)} ${node.chart.type} ` +
          (node.chart.type === "pie"
            ? `segments=${node.chart.segments.length}`
            : `series=${node.chart.series.length} categories=${node.chart.categories.length}`),
      ];
    case "LinkButton":
      return [`${pad}LinkButton ${json(node.label)} ${node.url}`];
    case "Placeholder":
      return [`${pad}!${node.name} ${node.reason}`];
  }
}

export function summarize(read: DisplayRead) {
  return read.ok ? { outline: outline(read.root) } : { fails: read.reason };
}

// ---- builders -------------------------------------------------------------

const lines = (...patches: unknown[]) =>
  patches.map((patch) => JSON.stringify(patch)).join("\n");
const root = (key: string) => ({ op: "add", path: "/root", value: key });
const element = (
  key: string,
  type: string,
  props: Record<string, unknown> = {},
  children?: string[],
  extra: Record<string, unknown> = {},
) => ({
  op: "add",
  path: `/elements/${key}`,
  value: { type, props, ...(children ? { children } : {}), ...extra },
});
// A Card at the root holding one element under test.
const inCard = (child: ReturnType<typeof element>, key = "x") =>
  lines(
    root("card"),
    element("card", "Card", { title: "Frame" }, [key]),
    child,
  );
const pad = (source: string, length: number) =>
  source + " ".repeat(length - source.length);

const dividers = (count: number) =>
  lines(
    root("s"),
    element("s", "Section", {}, Array(count).fill("d")),
    element("d", "Divider"),
  );
const nest = (depth: number) =>
  lines(
    root("n1"),
    ...Array.from({ length: depth }, (_, i) =>
      i === depth - 1
        ? element(`n${i + 1}`, "Divider")
        : element(`n${i + 1}`, "Section", {}, [`n${i + 2}`]),
    ),
  );
const chartCard = (chart: unknown) =>
  inCard(element("x", "Chart", { title: "Trend", chart }));

const validBase = lines(root("d"), element("d", "Card", { title: "T" }));
const sized = (length: number) => pad(validBase, length);

export const displayFixtures: DisplayFixture[] = [
  // ---- valid blocks -------------------------------------------------------
  {
    name: "the handoff example",
    source: [
      '{"op":"add","path":"/root","value":"summary"}',
      '{"op":"add","path":"/elements/summary","value":{"type":"Card","props":{"title":"Weekly deploys"},"children":["kpis"]}}',
      '{"op":"add","path":"/elements/kpis","value":{"type":"Fields","props":{},"children":["total"]}}',
      '{"op":"add","path":"/elements/total","value":{"type":"Field","props":{"label":"Deploys","value":"1,284"}}}',
    ].join("\n"),
    expect: {
      outline: [
        'Card title="Weekly deploys"',
        "  Fields",
        '    Field "Deploys"="1,284"',
      ],
    },
  },
  {
    name: "every component",
    source: lines(
      root("card"),
      element("card", "Card", { title: "Report", subtitle: "Nov" }, [
        "sec",
        "txt",
        "fields",
        "tbl",
        "chart",
        "div",
        "actions",
      ]),
      element("sec", "Section", {}, ["bold"]),
      element("bold", "Text", { content: "**Up**", style: "bold" }),
      element("txt", "Text", { content: "Plain text" }),
      element("fields", "Fields", {}, ["f1"]),
      element("f1", "Field", { label: "Runs", value: "12" }),
      element("tbl", "Table", {
        headers: ["Project", "Deploys"],
        rows: [["web", "412"]],
        align: ["left", "right"],
        caption: "By project",
      }),
      element("chart", "Chart", {
        title: "Share",
        chart: { type: "pie", segments: [{ label: "web", value: 3 }] },
      }),
      element("div", "Divider"),
      element("actions", "Actions", {}, ["link"]),
      element("link", "LinkButton", {
        label: "Open",
        url: "https://example.com/a",
      }),
    ),
    expect: {
      outline: [
        'Card title="Report" subtitle="Nov"',
        "  Section",
        '    Text style=bold "**Up**" len=6',
        '  Text style=plain "Plain text" len=10',
        "  Fields",
        '    Field "Runs"="12"',
        '  Table headers=["Project","Deploys"] align=["left","right"] caption="By project" rows=1 first=["web","412"] last=["web","412"]',
        '  Chart "Share" pie segments=1',
        "  Divider",
        "  Actions",
        '    LinkButton "Open" https://example.com/a',
      ],
    },
  },
  {
    name: "a bar chart",
    source: chartCard({
      type: "bar",
      categories: ["Mon", "Tue"],
      series: [{ name: "Deploys", values: [1, 2] }],
      xLabel: "Day",
      yLabel: "Count",
    }),
    expect: {
      outline: [
        'Card title="Frame"',
        '  Chart "Trend" bar series=1 categories=2',
      ],
    },
  },
  {
    name: "a line chart",
    source: chartCard({
      type: "line",
      categories: ["a", "b", "c"],
      series: [
        { name: "One", values: [1, 2, 3] },
        { name: "Two", values: [3, 2, 1] },
      ],
    }),
    expect: {
      outline: [
        'Card title="Frame"',
        '  Chart "Trend" line series=2 categories=3',
      ],
    },
  },
  {
    name: "an area chart",
    source: chartCard({
      type: "area",
      categories: ["a"],
      series: [{ name: "One", values: [4] }],
    }),
    expect: {
      outline: [
        'Card title="Frame"',
        '  Chart "Trend" area series=1 categories=1',
      ],
    },
  },
  {
    name: "a pie chart",
    source: chartCard({
      type: "pie",
      segments: [
        { label: "a", value: 1 },
        { label: "b", value: 2.5 },
      ],
    }),
    expect: {
      outline: ['Card title="Frame"', '  Chart "Trend" pie segments=2'],
    },
  },
  {
    name: "a later line replaces an earlier element",
    source: lines(
      root("t"),
      element("t", "Text", { content: "first" }),
      element("t", "Text", { content: "second" }),
    ),
    expect: { outline: ['Text style=plain "second" len=6'] },
  },
  {
    name: "replace is read like add",
    source: lines(
      { op: "replace", path: "/root", value: "t" },
      { op: "replace", path: "/elements/t", value: { type: "Divider" } },
    ),
    expect: { outline: ["Divider"] },
  },
  {
    name: "the root may be set after the elements",
    source: lines(element("t", "Divider"), root("t")),
    expect: { outline: ["Divider"] },
  },
  {
    name: "pointer escapes in an element key",
    source: lines(root("a/b~c"), {
      op: "add",
      path: "/elements/a~1b~0c",
      value: { type: "Divider" },
    }),
    expect: { outline: ["Divider"] },
  },
  {
    name: "a number where a value is shown",
    source: lines(
      root("f"),
      element("f", "Field", { label: "Count", value: 1284 }),
    ),
    expect: { outline: ['Field "Count"="1284"'] },
  },
  {
    name: "a short row is padded and a long row is cut",
    source: lines(
      root("t"),
      element("t", "Table", {
        headers: ["a", "b"],
        rows: [["1"], ["1", "2", "3"]],
      }),
    ),
    expect: {
      outline: [
        'Table headers=["a","b"] align=["left","left"] caption=null rows=2 first=["1",""] last=["1","2"]',
      ],
    },
  },
  {
    name: "a short align list defaults to left",
    source: lines(
      root("t"),
      element("t", "Table", {
        headers: ["a", "b", "c"],
        rows: [],
        align: ["right"],
      }),
    ),
    expect: {
      outline: [
        'Table headers=["a","b","c"] align=["right","left","left"] caption=null rows=0 first=null last=null',
      ],
    },
  },
  {
    name: "unknown props are ignored",
    source: lines(
      root("t"),
      element("t", "Text", { content: "hi", color: "red", on: 1 }, undefined, {
        on: { press: { action: "x" } },
        slots: { default: ["y"] },
      }),
    ),
    expect: { outline: ['Text style=plain "hi" len=2'] },
  },
  {
    name: "children are ignored on a component that takes none",
    source: lines(
      root("t"),
      element("t", "Text", { content: "hi" }, ["nowhere"]),
    ),
    expect: { outline: ['Text style=plain "hi" len=2'] },
  },
  {
    name: "a Text whose content contains spec and mermaid fences",
    source: lines(
      root("t"),
      element("t", "Text", {
        content: '```spec\n{"op":"add"}\n```\n```mermaid\ngraph TD\n```',
      }),
    ),
    expect: {
      outline: [
        'Text style=plain "```spec\\n{\\"op\\":\\"add\\"}\\n```\\n```mermaid\\ngraph TD\\n```" len=48',
      ],
    },
  },
  {
    name: "a child reached twice is drawn twice",
    source: lines(
      root("s"),
      element("s", "Section", {}, ["d", "d"]),
      element("d", "Divider"),
    ),
    expect: { outline: ["Section", "  Divider", "  Divider"] },
  },
  {
    name: "an element the root never reaches is not drawn",
    source: lines(
      root("d"),
      element("d", "Divider"),
      element("unused", "Nonsense"),
    ),
    expect: { outline: ["Divider"] },
  },

  // ---- skipped lines ------------------------------------------------------
  {
    name: "a remove operation is skipped",
    source: lines(root("d"), element("d", "Divider"), {
      op: "remove",
      path: "/elements/d",
    }),
    expect: { outline: ["Divider"] },
    skipped: 1,
  },
  {
    name: "a deeper path is skipped",
    source: lines(root("t"), element("t", "Text", { content: "kept" }), {
      op: "add",
      path: "/elements/t/props/content",
      value: "changed",
    }),
    expect: { outline: ['Text style=plain "kept" len=4'] },
    skipped: 1,
  },
  {
    name: "a state line is skipped",
    source: lines(root("d"), element("d", "Divider"), {
      op: "add",
      path: "/state/x",
      value: 1,
    }),
    expect: { outline: ["Divider"] },
    skipped: 1,
  },
  {
    name: "a line that is not JSON is skipped",
    source: [
      lines(root("d"), element("d", "Divider")),
      "not json {",
      "[1]",
      "7",
    ].join("\n"),
    expect: { outline: ["Divider"] },
    skipped: 3,
  },
  {
    name: "blank lines are not counted",
    source: [
      "",
      lines(root("d")),
      "   ",
      "",
      lines(element("d", "Divider")),
      "",
    ].join("\n"),
    expect: { outline: ["Divider"] },
  },
  {
    name: "a root that is not a string and an element that is not an object are skipped",
    source: lines(
      root("d"),
      element("d", "Divider"),
      { op: "add", path: "/root", value: 3 },
      { op: "add", path: "/elements/e", value: "nope" },
      { op: "add", path: "/elements/", value: { type: "Divider" } },
    ),
    expect: { outline: ["Divider"] },
    skipped: 3,
  },

  // ---- elements that become placeholders ----------------------------------
  {
    name: "an unknown component",
    source: inCard(element("x", "Gauge", { value: 3 })),
    expect: { outline: ['Card title="Frame"', "  !Gauge unsupported"] },
  },
  {
    name: "a component named like an object property",
    source: inCard(element("x", "constructor")),
    expect: { outline: ['Card title="Frame"', "  !constructor unsupported"] },
  },
  {
    name: "a Button is not supported",
    source: inCard(element("x", "Button", { id: "approve", label: "Approve" })),
    expect: { outline: ['Card title="Frame"', "  !Button unsupported"] },
  },
  {
    name: "an Image is not supported",
    source: inCard(
      element("x", "Image", { url: "https://example.com/a.png", alt: "a" }),
    ),
    expect: { outline: ['Card title="Frame"', "  !Image unsupported"] },
  },
  {
    name: "an element with visible",
    source: inCard(
      element("x", "Text", { content: "hidden?" }, undefined, {
        visible: { $state: "/show" },
      }),
    ),
    expect: { outline: ['Card title="Frame"', "  !Text unsupported"] },
  },
  {
    name: "an element with repeat",
    source: inCard(
      element("x", "Text", { content: "row" }, undefined, {
        repeat: { statePath: "/rows" },
      }),
    ),
    expect: { outline: ['Card title="Frame"', "  !Text unsupported"] },
  },
  {
    name: "a prop holding a state expression",
    source: inCard(element("x", "Text", { content: { $state: "/greeting" } })),
    expect: { outline: ['Card title="Frame"', "  !Text invalid"] },
  },
  {
    name: "an element with no type",
    source: lines(root("x"), {
      op: "add",
      path: "/elements/x",
      value: { props: {} },
    }),
    expect: { outline: ["!Element unsupported"] },
  },
  {
    name: "a LinkButton with a javascript URL",
    source: inCard(
      element("x", "LinkButton", { label: "Go", url: "javascript:alert(1)" }),
    ),
    expect: { outline: ['Card title="Frame"', "  !LinkButton invalid"] },
  },
  {
    name: "a LinkButton with a relative URL",
    source: inCard(
      element("x", "LinkButton", { label: "Go", url: "/settings" }),
    ),
    expect: { outline: ['Card title="Frame"', "  !LinkButton invalid"] },
  },
  {
    name: "a Text with empty content",
    source: inCard(element("x", "Text", { content: "" })),
    expect: { outline: ['Card title="Frame"', "  !Text invalid"] },
  },
  {
    name: "children that are not a list of keys",
    source: lines(
      root("s"),
      element("s", "Section", {}, undefined, { children: "d" }),
    ),
    expect: { outline: ["!Section invalid"] },
  },
  {
    name: "one bad element leaves its siblings drawn",
    source: lines(
      root("s"),
      element("s", "Section", {}, ["a", "b", "c"]),
      element("a", "Divider"),
      element("b", "Field", { label: "only a label" }),
      element("c", "Divider"),
    ),
    expect: {
      outline: ["Section", "  Divider", "  !Field invalid", "  Divider"],
    },
  },
  {
    name: "a missing child",
    source: lines(
      root("s"),
      element("s", "Section", {}, ["d", "ghost"]),
      element("d", "Divider"),
    ),
    expect: { outline: ["Section", "  Divider", "  !Element invalid"] },
  },
  {
    name: "an element that contains itself",
    source: lines(root("s"), element("s", "Section", {}, ["s"])),
    expect: { outline: ["Section", "  !Section invalid"] },
  },
  {
    name: "a loop through two elements",
    source: lines(
      root("a"),
      element("a", "Section", {}, ["b"]),
      element("b", "Section", {}, ["a"]),
    ),
    expect: { outline: ["Section", "  Section", "    !Section invalid"] },
  },

  // ---- blocks that can't be drawn -----------------------------------------
  {
    name: "no lines at all",
    source: "",
    expect: { fails: "empty" },
  },
  {
    name: "only lines that are skipped",
    source: lines(
      { op: "remove", path: "/root" },
      { op: "add", path: "/state/a", value: 1 },
    ),
    expect: { fails: "empty" },
    skipped: 2,
  },
  {
    name: "elements but no root",
    source: lines(element("d", "Divider")),
    expect: { fails: "no_root" },
  },
  {
    name: "a root naming a missing element",
    source: lines(root("ghost"), element("d", "Divider")),
    expect: { fails: "missing_root" },
  },
  {
    name: "a root with no elements",
    source: lines(root("d")),
    expect: { fails: "missing_root" },
  },

  // ---- limits: at the limit, then just over -------------------------------
  {
    name: "source at the size limit",
    source: sized(DISPLAY_LIMITS.source),
    expect: { outline: ['Card title="T"'] },
  },
  {
    name: "source over the size limit",
    source: sized(DISPLAY_LIMITS.source + 1),
    expect: { fails: "too_large" },
  },
  {
    name: "elements at the limit",
    source: dividers(DISPLAY_LIMITS.elements - 1),
    expect: {
      outline: [
        "Section",
        ...Array(DISPLAY_LIMITS.elements - 1).fill("  Divider"),
      ],
    },
  },
  {
    name: "elements over the limit",
    source: dividers(DISPLAY_LIMITS.elements),
    expect: { fails: "too_many_elements" },
  },
  {
    name: "nesting at the depth limit",
    source: nest(DISPLAY_LIMITS.depth),
    expect: {
      outline: Array.from(
        { length: DISPLAY_LIMITS.depth },
        (_, i) =>
          "  ".repeat(i) +
          (i === DISPLAY_LIMITS.depth - 1 ? "Divider" : "Section"),
      ),
    },
  },
  {
    name: "nesting over the depth limit",
    source: nest(DISPLAY_LIMITS.depth + 1),
    expect: { fails: "too_deep" },
  },
  {
    name: "a table at the row and column limits",
    source: lines(
      root("t"),
      element("t", "Table", {
        headers: Array.from(
          { length: DISPLAY_LIMITS.tableColumns },
          (_, i) => `h${i}`,
        ),
        rows: Array.from({ length: DISPLAY_LIMITS.tableRows }, () => ["x"]),
      }),
    ),
    expect: {
      outline: [
        `Table headers=${JSON.stringify(Array.from({ length: DISPLAY_LIMITS.tableColumns }, (_, i) => `h${i}`))} align=${JSON.stringify(Array(DISPLAY_LIMITS.tableColumns).fill("left"))} caption=null rows=${DISPLAY_LIMITS.tableRows} first=${JSON.stringify(["x", ...Array(DISPLAY_LIMITS.tableColumns - 1).fill("")])} last=${JSON.stringify(["x", ...Array(DISPLAY_LIMITS.tableColumns - 1).fill("")])}`,
      ],
    },
  },
  {
    name: "a table over the row limit",
    source: inCard(
      element("x", "Table", {
        headers: ["a"],
        rows: Array.from({ length: DISPLAY_LIMITS.tableRows + 1 }, () => ["x"]),
      }),
    ),
    expect: { outline: ['Card title="Frame"', "  !Table invalid"] },
  },
  {
    name: "a table over the column limit",
    source: inCard(
      element("x", "Table", {
        headers: Array.from(
          { length: DISPLAY_LIMITS.tableColumns + 1 },
          () => "h",
        ),
        rows: [],
      }),
    ),
    expect: { outline: ['Card title="Frame"', "  !Table invalid"] },
  },
  {
    name: "a chart at the series and category limits",
    source: chartCard({
      type: "bar",
      categories: Array.from(
        { length: DISPLAY_LIMITS.categories },
        (_, i) => `c${i}`,
      ),
      series: Array.from({ length: DISPLAY_LIMITS.seriesCount }, (_, i) => ({
        name: `s${i}`,
        values: [1],
      })),
    }),
    expect: {
      outline: [
        'Card title="Frame"',
        `  Chart "Trend" bar series=${DISPLAY_LIMITS.seriesCount} categories=${DISPLAY_LIMITS.categories}`,
      ],
    },
  },
  {
    name: "a chart over the series limit",
    source: chartCard({
      type: "line",
      categories: ["a"],
      series: Array.from(
        { length: DISPLAY_LIMITS.seriesCount + 1 },
        (_, i) => ({
          name: `s${i}`,
          values: [1],
        }),
      ),
    }),
    expect: { outline: ['Card title="Frame"', "  !Chart invalid"] },
  },
  {
    name: "a chart over the category limit",
    source: chartCard({
      type: "area",
      categories: Array.from(
        { length: DISPLAY_LIMITS.categories + 1 },
        (_, i) => `c${i}`,
      ),
      series: [{ name: "s", values: [1] }],
    }),
    expect: { outline: ['Card title="Frame"', "  !Chart invalid"] },
  },
  {
    name: "a pie at the segment limit",
    source: chartCard({
      type: "pie",
      segments: Array.from({ length: DISPLAY_LIMITS.pieSegments }, (_, i) => ({
        label: `p${i}`,
        value: 1,
      })),
    }),
    expect: {
      outline: [
        'Card title="Frame"',
        `  Chart "Trend" pie segments=${DISPLAY_LIMITS.pieSegments}`,
      ],
    },
  },
  {
    name: "a pie over the segment limit",
    source: chartCard({
      type: "pie",
      segments: Array.from(
        { length: DISPLAY_LIMITS.pieSegments + 1 },
        (_, i) => ({
          label: `p${i}`,
          value: 1,
        }),
      ),
    }),
    expect: { outline: ['Card title="Frame"', "  !Chart invalid"] },
  },
  {
    name: "a pie segment that is not positive",
    source: chartCard({ type: "pie", segments: [{ label: "a", value: 0 }] }),
    expect: { outline: ['Card title="Frame"', "  !Chart invalid"] },
  },
  {
    name: "a string at the length limit",
    source: lines(
      root("t"),
      element("t", "Text", { content: "x".repeat(DISPLAY_LIMITS.text) }),
    ),
    expect: {
      outline: [
        `Text style=plain "${"x".repeat(60)}" len=${DISPLAY_LIMITS.text}`,
      ],
    },
  },
  {
    name: "a string over the length limit",
    source: inCard(
      element("x", "Text", { content: "x".repeat(DISPLAY_LIMITS.text + 1) }),
    ),
    expect: { outline: ['Card title="Frame"', "  !Text invalid"] },
  },
];
