import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../src/client/components";
import { tickLabels, valueScale } from "../src/client/DisplayChart";
import { displayFixtures } from "./display-spec-fixtures";

const fence = (source: string) => "```spec\n" + source + "\n```";
const render = (content: string, compact = false) =>
  renderToStaticMarkup(<RichText content={content} compact={compact} />);
const chart = (title: string, data: unknown) =>
  fence(
    [
      { op: "add", path: "/root", value: "c" },
      {
        op: "add",
        path: "/elements/c",
        value: { type: "Chart", props: { title, chart: data } },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
const count = (html: string, pattern: RegExp) =>
  html.match(pattern)?.length ?? 0;

it("draws every valid chart fixture as SVG with finite coordinates and a table", () => {
  const charts = displayFixtures.filter(
    (fixture) =>
      "outline" in fixture.expect &&
      fixture.expect.outline.some((line) => /^\s*Chart /.test(line)),
  );
  expect(charts.length).toBeGreaterThanOrEqual(12);
  for (const fixture of charts) {
    const html = render(fence(fixture.source));
    const drawn = (fixture.expect as { outline: string[] }).outline.filter(
      (line) => /^\s*Chart /.test(line),
    ).length;
    expect(count(html, /class="display-chart-svg"/g), fixture.name).toBe(drawn);
    expect(count(html, /<details class="display-chart-numbers"/g)).toBe(drawn);
    expect(html, fixture.name).not.toMatch(/NaN|Infinity|undefined/);
    expect(html).not.toContain("Chart is not supported here");
  }
});

it("names the chart and lists its numbers in a table", () => {
  const html = render(
    chart("Weekly deploys", {
      type: "bar",
      categories: ["Mon", "Tue", "Wed"],
      series: [{ name: "Deploys", values: [180, 210, 195] }],
      xLabel: "Day",
      yLabel: "Deploys",
    }),
  );
  expect(html).toContain("<figcaption");
  expect(html).toContain(
    'role="img" aria-label="Weekly deploys. Bar chart, 1 series, 3 categories. The numbers are in the table below."',
  );
  expect(html).toContain("<summary>Show the numbers</summary>");
  expect(html).toContain(
    '<th scope="row">Tue</th><td class="align-right">210</td>',
  );
  expect(html).toContain('<th scope="col">Day</th>');
  expect(count(html, /<rect x=/g)).toBe(3);
  // One series: no legend.
  expect(html).not.toContain("display-chart-legend");
  // No provenance line like the chart artifact's.
  expect(html).not.toMatch(/Source:|Captured/);
});

it("draws a short series as far as it goes and marks the gaps in the table", () => {
  const html = render(
    chart("Short", {
      type: "line",
      categories: ["a", "b", "c", "d"],
      series: [{ name: "s", values: [1, 2] }],
    }),
  );
  expect(count(html, /<circle [^>]*r="2.5"/g)).toBe(2);
  expect(count(html, /<td class="align-right">—<\/td>/g)).toBe(2);
});

it("drops values beyond the categories", () => {
  const html = render(
    chart("Long", {
      type: "bar",
      categories: ["a", "b"],
      series: [{ name: "s", values: [1, 2, 3, 4] }],
    }),
  );
  expect(count(html, /<rect x=/g)).toBe(2);
  expect(html).not.toContain(">3</td>");
});

it("groups bars side by side and gives repeated colours a second cue", () => {
  const html = render(
    chart("Many", {
      type: "bar",
      categories: ["a", "b"],
      series: Array.from({ length: 9 }, (_, i) => ({
        name: `s${i}`,
        values: [i + 1, i + 2],
      })),
    }),
  );
  expect(count(html, /<rect x=/g)).toBe(18);
  // Series 4 to 7 are hatched, series 8 dotted.
  expect(html).toMatch(/fill="url\(#[\w-]+-p0-1\)"/);
  expect(html).toMatch(/fill="url\(#[\w-]+-p0-2\)"/);
  expect(count(html, /<li>/g)).toBe(9);
});

it("dashes repeated colours on a line chart", () => {
  const html = render(
    chart("Lines", {
      type: "line",
      categories: ["a", "b"],
      series: Array.from({ length: 5 }, (_, i) => ({
        name: `s${i}`,
        values: [i, i + 1],
      })),
    }),
  );
  expect(html).toContain('stroke-dasharray="6 3"');
});

it("labels each pie segment with its share, and draws one segment as a circle", () => {
  const html = render(
    chart("Split", {
      type: "pie",
      segments: [
        { label: "web", value: 3 },
        { label: "api", value: 1 },
      ],
    }),
  );
  expect(html).toContain("web 75%");
  expect(html).toContain("api 25%");
  expect(count(html, /<path d="M/g)).toBe(2);
  const one = render(
    chart("All", { type: "pie", segments: [{ label: "all", value: 2 }] }),
  );
  expect(one).toContain('<circle cx="180" cy="110" r="98"');
  expect(one).toContain("all 100%");
});

it("draws a dominant pie segment whole when the rest are too small to see", () => {
  const html = render(
    chart("Lopsided", {
      type: "pie",
      segments: [
        { label: "big", value: 1e300 },
        { label: "small", value: 1e-300 },
      ],
    }),
  );
  expect(html).toContain('<circle cx="180" cy="110" r="98"');
  expect(html).not.toMatch(/NaN|Infinity/);
});

it("fills area charts to zero, below it for negative values", () => {
  const html = render(
    chart("Area", {
      type: "area",
      categories: ["a", "b", "c"],
      series: [{ name: "s", values: [-3, 0, 5] }],
    }),
  );
  const scale = valueScale([-3, 0, 5], true);
  const zero = Math.round(scale.y(0) * 100) / 100;
  expect(html).toContain(`,${zero}Z`);
});

it("leaves out the table of numbers in a compact preview", () => {
  const html = render(
    chart("Compact", {
      type: "line",
      categories: ["a", "b"],
      series: [{ name: "s", values: [1, 2] }],
    }),
    true,
  );
  expect(html).toContain('class="display-chart-svg"');
  expect(html).not.toContain("<details");
});

it("gives equal, zero, huge and tiny values a span with distinct tick labels", () => {
  for (const [values, fromZero] of [
    [[0, 0, 0], true],
    [[7, 7, 7], false],
    [[7, 7, 7], true],
    [[-2, -2], false],
    [[-1.7e308, 1.7e308], false],
    [[1.7e308, 1.7e308], false],
    [[-1.7e308, -1.7e308], false],
    [[Number.MAX_VALUE, Number.MAX_VALUE], false],
    [[5e-324, 1e-323], false],
    [[1e9, 1e9 + 1], false],
    [[0.1, 0.2, 0.30000000000000004], false],
    [[], true],
  ] as [number[], boolean][]) {
    const scale = valueScale(values, fromZero);
    expect(scale.ticks.length, String(values)).toBeGreaterThanOrEqual(2);
    expect(scale.ticks.every(Number.isFinite)).toBe(true);
    const labels = tickLabels(scale.ticks);
    expect(new Set(labels).size, String(values)).toBe(labels.length);
    for (const value of values) {
      const y = scale.y(value);
      expect(Number.isFinite(y), String(values)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(11.99);
      expect(y).toBeLessThanOrEqual(186.01);
    }
  }
});

it("keeps equal values near the float limit finite", () => {
  for (const value of [1.7e308, -1.7e308, Number.MAX_VALUE]) {
    const html = render(
      chart("Flat", {
        type: "line",
        categories: ["a", "b"],
        series: [{ name: "s", values: [value, value] }],
      }),
    );
    expect(html).not.toMatch(/NaN|Infinity/);
  }
});

it("never paints a dense bar over its neighbour", () => {
  const html = render(
    chart("Dense", {
      type: "bar",
      categories: Array.from({ length: 200 }, (_, i) => `c${i}`),
      series: Array.from({ length: 12 }, (_, s) => ({
        name: `s${s}`,
        values: Array(200).fill(s + 1),
      })),
    }),
  );
  const bars = [
    ...html.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g),
  ]
    .map((match) => [Number(match[1]), Number(match[2])])
    .sort((a, b) => a[0] - b[0]);
  expect(bars).toHaveLength(2400);
  for (let i = 1; i < bars.length; i++)
    expect(bars[i - 1][0] + bars[i - 1][1]).toBeLessThanOrEqual(
      bars[i][0] + 0.011,
    );
});

it("does not point a compact chart at a table it leaves out", () => {
  const data = {
    type: "line",
    categories: ["a", "b"],
    series: [{ name: "s", values: [1, 2] }],
  };
  expect(render(chart("Small", data), true)).toContain(
    'aria-label="Small. Line chart, 1 series, 2 categories."',
  );
  expect(render(chart("Small", data))).toContain(
    "The numbers are in the table below.",
  );
});
