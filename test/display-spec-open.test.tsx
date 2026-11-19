import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../src/client/components";
import { readDisplaySpec, type DisplayNode } from "../src/shared/display-spec";
import { dropSpecBlocks, plainPreview } from "../src/shared/text";
import { searchExcerpt } from "../src/shared/search-excerpt";
import { collapse } from "../src/server/collapse";
import { outline } from "./display-spec-fixtures";

const patch = (...lines: unknown[]) =>
  lines.map((line) => JSON.stringify(line)).join("\n");
const add = (key: string, value: unknown) => ({
  op: "add",
  path: `/elements/${key}`,
  value,
});
const block = patch(
  { op: "add", path: "/root", value: "card" },
  add("card", {
    type: "Card",
    props: { title: "Weekly deploys" },
    children: ["fields", "table", "chart", "actions"],
  }),
  add("fields", { type: "Fields", children: ["f1", "f2"] }),
  add("f1", { type: "Field", props: { label: "Deploys", value: "1,284" } }),
  add("f2", { type: "Field", props: { label: "Failures", value: 3 } }),
  add("table", {
    type: "Table",
    props: { headers: ["Project", "Deploys"], rows: [["web", 412]] },
  }),
  {
    op: "replace",
    path: "/elements/table",
    value: {
      type: "Table",
      props: {
        headers: ["Project", "Deploys"],
        rows: [
          ["web", 412],
          ["api", 288],
        ],
      },
    },
  },
  add("chart", {
    type: "Chart",
    props: {
      title: "Trend",
      chart: {
        type: "line",
        categories: ["Mon", "Tue"],
        series: [{ name: "Deploys", values: [180, 210] }],
      },
    },
  }),
  add("actions", { type: "Actions", children: ["open"] }),
  add("open", {
    type: "LinkButton",
    props: { label: "Open", url: "https://example.com/a" },
  }),
);
const size = (node: DisplayNode): number =>
  1 + ("children" in node ? node.children.reduce((n, c) => n + size(c), 0) : 0);

it("reads every prefix of a block being written, never drawing less", () => {
  let previous = 0;
  for (let end = 0; end <= block.length; end++) {
    const read = readDisplaySpec(block.slice(0, end), {
      open: true,
      writing: true,
    });
    // A half-written last line is ignored, never counted as skipped.
    expect(read.skippedCount, `prefix ${end}`).toBe(0);
    const drawn = read.ok ? size(read.root) : 0;
    expect(drawn, `prefix ${end}`).toBeGreaterThanOrEqual(previous);
    if (read.ok)
      expect(
        outline(read.root).some((line) => line.includes("!")),
        `prefix ${end} drew a placeholder`,
      ).toBe(false);
    previous = drawn;
  }
  // The whole block, still open, draws what the closed block draws.
  const whole = readDisplaySpec(block, { open: true, writing: true });
  const closed = readDisplaySpec(block);
  expect(whole.ok && closed.ok).toBe(true);
  if (whole.ok && closed.ok)
    expect(outline(whole.root)).toEqual(outline(closed.root));
});

const fence = "```spec\n";
const render = (content: string, writing: boolean, compact = false) =>
  renderToStaticMarkup(
    <RichText content={content} writing={writing} compact={compact} />,
  );

it("draws an open block inside prose as far as it is written", () => {
  const lines = block.split("\n");
  const partial = lines.slice(0, 5).join("\n") + '\n{"op":"add","pa';
  const html = render(`Here is the report.\n\n${fence}${partial}`, true);
  expect(html).toContain("<p>Here is the report.</p>");
  expect(html).toContain('class="display-spec"');
  expect(html).toContain("Weekly deploys");
  expect(html).toContain("<dd>1,284</dd>");
  // Children not yet written are left out, not shown as placeholders.
  expect(html).not.toContain("could not be shown");
  expect(html).not.toContain("could not be drawn");
  expect(html).not.toContain("&quot;op&quot;");
});

it("says the display is loading until its root element arrives", () => {
  for (const partial of ["", '{"op":"add","path":"/root","value":"card"}'])
    expect(render(`Before.\n\n${fence}${partial}`, true)).toContain(
      "Display loading…",
    );
});

it("treats an open block in a finished answer as final", () => {
  const lines = block.split("\n");
  const partial = lines.slice(0, 5).join("\n");
  const html = render(`${fence}${partial}`, false);
  expect(html).not.toContain("Display loading…");
  expect(html).toContain("This part of the display could not be shown");
  // No root at all: the source, as for a closed block.
  const empty = render(`${fence}{"op":"add","pa`, false);
  expect(empty).not.toContain("Display loading…");
  expect(empty).toContain("This display could not be drawn");
});

it("draws a closed block the same whether or not the answer is written", () => {
  const closed = `Intro.\n\n${fence}${block}\n\`\`\`\n\nOutro.`;
  expect(render(closed, true)).toBe(render(closed, false));
  expect(render(closed, true)).not.toContain("Display loading…");
});

it("leaves other open fences exactly as before", () => {
  for (const content of [
    "Text\n\n```mermaid\ngraph TD\nA-->B",
    "Text\n\n```ts\nconst a = 1;",
    "Text\n\n~~~\nplain",
  ]) {
    const plain = renderToStaticMarkup(
      <RichText content={content} diagrams={false} />,
    );
    expect(render(content, true)).toBe(render(content, false));
    expect(plain).not.toContain("data-spec-open");
  }
  // With displays off (GitHub text), a spec fence stays plain code.
  const github = renderToStaticMarkup(
    <RichText content={`${fence}{"op"`} diagrams={false} />,
  );
  expect(github).toContain('<code class="language-spec">');
  expect(github).not.toContain("data-spec-open");
});

it("tells a closed fence from an open one inside quotes and lists", () => {
  const root = '{"op":"add","path":"/root","value":"d"}';
  const quoted = `> ${fence.trim()}\n> ${root}`;
  expect(render(quoted, true)).toContain("Display loading…");
  const listed = `- ${fence.trim()}\n  ${root}\n  \`\`\``;
  expect(render(listed, true)).toContain("This display could not be drawn");
});

it("drops an open fence and what follows it from plain previews", () => {
  expect(
    plainPreview('Here it is.\n\n```spec\n{"op":"add","path":"/root"'),
  ).toBe("Here it is.");
  expect(plainPreview("Run this:\n```sh\nnpm test")).toBe("Run this:");
  expect(plainPreview('Closed ```a``` and open ```spec\n{"op"', 140)).toBe(
    "Closed and open",
  );
});

it("keeps plain previews identical for text with no open fence", () => {
  const before = (text: string, length = 140) => {
    const flat = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(^|\s)#{1,6}\s+/g, "$1")
      .replace(/(\*\*|__|`)/g, "")
      .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, " ")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return flat.length > length
      ? flat.slice(0, length - 1).trimEnd() + "…"
      : flat;
  };
  for (const text of [
    "# Title\n\nSome **bold** and `code` text.",
    "- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    "Before\n```spec\n{}\n```\nAfter",
    "Before\n```ts\nconst a = 1;\n```\nAfter ```inline``` end",
    "[link](https://example.com) and ![img](x.png)",
    "A".repeat(300),
    "",
  ])
    expect(plainPreview(text)).toBe(before(text));
});

it("drops closed and open spec blocks from other plain text", () => {
  const closed = `Summary first.\n\n${fence}${block}\n\`\`\`\n\nThen more words.`;
  const open = `Summary first.\n\n${fence}${block.slice(0, 120)}`;
  expect(dropSpecBlocks(closed)).toBe("Summary first.\n\n\nThen more words.");
  expect(dropSpecBlocks(open)).toBe("Summary first.\n\n");
  // Other fences, and a spec fence quoted inside another fence, stay.
  const nested = "````md\n```spec\n{}\n```\n````\nand ```ts\nx\n```";
  expect(dropSpecBlocks(nested)).toBe(nested);
  expect(dropSpecBlocks("```ts\nconst spec = 1;\n```")).toBe(
    "```ts\nconst spec = 1;\n```",
  );
  for (const text of [closed, open]) {
    expect(collapse(text, 200)).not.toContain('"op"');
    expect(searchExcerpt(text, "", "deploys")).not.toContain('"op"');
    expect(plainPreview(text)).not.toContain('"op"');
  }
  expect(collapse(closed, 200)).toBe("Summary first. Then more words.");
});

it("preserves prose after long closed fences in plain previews", () => {
  expect(plainPreview("Before\n``````ts\nx\n``````\nAfter")).toBe(
    "Before After",
  );
});

it("drops nested and tilde-fenced display source from previews", () => {
  for (const source of [
    'Before\n\n> ```spec\n> {"op":"add"}\n> ```\n\nAfter',
    'Before\n\n- ~~~spec\n  {"op":"add"}\n  ~~~\n\nAfter',
    'Before\n\n> - ```spec\n>   {"op":"add"}',
    'Before\n\n~~~spec\n{"op":"add"}',
  ]) {
    const expected = source.endsWith("After") ? "Before After" : "Before";
    expect(collapse(source, 200)).toBe(expected);
    expect(plainPreview(source)).toBe(expected);
    expect(searchExcerpt(source, "", "")).toBe(expected);
  }
});

it("preserves indented code that resembles a display opener", () => {
  const source = "Before\n\n\t```spec\n\tcode\n\nAfter";
  expect(dropSpecBlocks(source)).toBe(source);
  expect(plainPreview(source)).toBe("Before spec code After");
});

it("keeps streaming when an indented delimiter is code content", () => {
  const root = '{"op":"add","path":"/root","value":"d"}';
  for (const source of [
    `\n${fence}${root}\n    \`\`\``,
    `> ${fence.trim()}\n> ${root}\n>     \`\`\``,
    `- ${fence.trim()}\n  ${root}\n      \`\`\``,
  ])
    expect(render(source, true)).toContain("Display loading…");
});
