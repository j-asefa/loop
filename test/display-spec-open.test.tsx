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
});

it("keeps prose after an unmatched literal inline delimiter", () => {
  expect(
    plainPreview("A literal \\``` marker.\n\nThe build failed."),
  ).toContain("The build failed.");
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
    "Marker ``````. Deployment succeeded. Another marker ``` here.",
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

it("drops displays inside GFM footnotes", () => {
  const source = [
    "Before [^display].",
    "",
    "[^display]: Summary",
    "",
    "    ~~~spec",
    ...block.split("\n").map((line) => "    " + line),
    "    ~~~",
    "",
    "After.",
  ].join("\n");
  for (const preview of [
    collapse(source, 200),
    plainPreview(source),
    searchExcerpt(source, "", ""),
  ]) {
    expect(preview).not.toContain('"op"');
    expect(preview).toContain("After.");
  }
});

it("drops a display following fence-like lines in block math", () => {
  const source = [
    "Before.",
    "",
    "$$",
    "```text",
    "$$",
    "",
    fence.trim(),
    '{"op":"add","path":"/root","value":"d"}',
    "```",
    "",
    "After.",
  ].join("\n");
  for (const preview of [
    collapse(source, 200),
    searchExcerpt(source, "", ""),
    plainPreview(source),
  ]) {
    expect(preview).not.toContain('"op"');
  }
});

it("finalizes an unclosed display when Markdown leaves its container", () => {
  const root = '{"op":"add","path":"/root","value":"d"}';
  for (const [opener, body, next] of [
    ["> ", "> ", "\n\nAfter."],
    ["- ", "  ", "\n- After."],
  ]) {
    const source = `${opener}${fence}${body}${root}`;
    expect(render(source + "\n\n", true)).toContain("Display loading…");
    const ended = render(source + next, true);
    expect(ended).toContain("This display could not be drawn");
    expect(ended).not.toContain("Display loading…");
    expect(ended).toContain("After.");
  }
});

it("keeps excerpts free of display source for display-only search matches", () => {
  const source = `${fence}${block}\n\`\`\``;
  expect(searchExcerpt(source, "", "Deploys")).toBe("");
  expect(searchExcerpt(`Summary.\n\n${source}`, "", "Deploys")).toBe(
    "Summary.",
  );
});

it("withholds source for an over-limit display only while it is open and writing", () => {
  const source =
    fence +
    patch(
      { op: "add", path: "/root", value: "d0" },
      ...Array.from({ length: 10 }, (_, i) =>
        add(`d${i}`, {
          type: "Section",
          children: i < 9 ? [`d${i + 1}`] : [],
        }),
      ),
    );
  const live = render(source, true, true);
  expect(live).toContain("This display could not be drawn yet.");
  expect(live).not.toContain("&quot;op&quot;");
  expect(render(source, false)).toContain("&quot;op&quot;");
  expect(render(source + "\n```", true)).toContain("&quot;op&quot;");
});

it("counts pending references against the element limit while writing", () => {
  const source = patch(
    { op: "add", path: "/root", value: "root" },
    add("root", { type: "Card", children: Array(200).fill("pending") }),
  );
  expect(readDisplaySpec(source, { open: true, writing: true })).toMatchObject({
    ok: false,
    reason: "too_many_elements",
  });
  expect(render(fence + source, true)).toContain(
    "This display could not be drawn yet.",
  );
});

it("warns when a finished display loses an incomplete replacement", () => {
  const source =
    patch(
      { op: "add", path: "/root", value: "card" },
      add("card", { type: "Card", props: { title: "Before the update" } }),
    ) + '\n{"op":"replace","path":"/elements/card","value":{"type":"Card"';
  const html = render(fence + source, false);
  expect(html).toContain("Before the update");
  expect(html).toContain("Some display updates could not be applied.");
  expect(render(fence + source, true)).not.toContain(
    "Some display updates could not be applied.",
  );
});

it("warns about incomplete updates when the answer leaves a display's quote", () => {
  const source =
    fence +
    patch(
      { op: "add", path: "/root", value: "card" },
      add("card", { type: "Card", props: { title: "Earlier value" } }),
    ) +
    '\n{"op":"replace","path":"/elements/card"';
  const quoted = source
    .split("\n")
    .map((line) => "> " + line)
    .join("\n");
  const html = render(quoted + "\n\nNext paragraph.", true);
  expect(html).toContain("Earlier value");
  expect(html).toContain("Some display updates could not be applied.");
});

it("finalizes a quote when Unicode paragraph content follows it", () => {
  const source =
    "> ```spec\n> " +
    patch({
      op: "add",
      path: "/root",
      value: "pending",
    });
  expect(render(source + "\n\n\u00a0", true)).toContain(
    "This display could not be drawn.",
  );
});

it("keeps partial source out of a capped thread preview", () => {
  const source = fence + '{"op":"add","path":"/root","value":"pending"}';
  const preview = renderToStaticMarkup(
    <RichText content={source} compact cappedPreview />,
  );
  expect(preview).toContain("Open the conversation to see this display.");
  expect(preview).not.toContain("&quot;op&quot;");
  expect(render(source, false)).toContain("&quot;op&quot;");
});

it("shows failure source when a capped preview contains the entire closing line", () => {
  const source = fence + '{"op":"add","path":"/root","value":"pending"}\n```';
  const preview = (content: string) =>
    renderToStaticMarkup(<RichText content={content} compact cappedPreview />);
  expect(preview(source + "\n\n  ")).toContain("&quot;op&quot;");
  expect(preview(source)).toContain(
    "Open the conversation to see this display.",
  );
});

it("hides missing children at the cutoff but shows them in the full answer", () => {
  const source =
    fence +
    patch(
      { op: "add", path: "/root", value: "card" },
      add("card", {
        type: "Card",
        props: { title: "Visible card" },
        children: ["child"],
      }),
    );
  for (const clipped of [source + "\n", source + "\n```"]) {
    const preview = renderToStaticMarkup(
      <RichText content={clipped} compact cappedPreview />,
    );
    expect(preview).toContain("Visible card");
    expect(preview).not.toContain("display-placeholder");
  }
  expect(render(source, false)).toContain("display-placeholder");
});

it("keeps decoded language whitespace consistent across rendering and plain previews", () => {
  const source =
    "```spec&#32;extra\n" + '{"op":"add","path":"/root","value":"pending"}';
  expect(render(source, true)).toContain("Display loading");
  expect(dropSpecBlocks("Before.\n\n" + source + "\n```\n\nAfter.")).toBe(
    "Before.\n\n\nAfter.",
  );
});

it("keeps a partial replacement from looking like a failed update in a capped preview", () => {
  const source =
    fence +
    patch(
      { op: "add", path: "/root", value: "card" },
      add("card", { type: "Card", props: { title: "Earlier value" } }),
    ) +
    '\n{"op":"replace","path":"/elements/card"';
  const preview = renderToStaticMarkup(
    <RichText content={source} compact cappedPreview />,
  );
  expect(preview).toContain("Earlier value");
  expect(preview).not.toContain("Some display updates could not be applied.");
  expect(render(source, false)).toContain(
    "Some display updates could not be applied.",
  );
});

it("waits for the final patch line ending in a capped preview", () => {
  const source =
    fence +
    patch(
      { op: "add", path: "/root", value: "card" },
      add("card", { type: "Card", props: { title: "Earlier value" } }),
      {
        op: "replace",
        path: "/elements/card",
        value: { type: "Card", props: { title: "Replacement value" } },
      },
    );
  const preview = (content: string) =>
    renderToStaticMarkup(<RichText content={content} compact cappedPreview />);
  expect(preview(source)).toContain("Earlier value");
  expect(preview(source)).not.toContain("Replacement value");
  expect(preview(source + "\n")).toContain("Replacement value");
  expect(render(source + " invalid suffix\n```", false)).toContain(
    "Earlier value",
  );
});
