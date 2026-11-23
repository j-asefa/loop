import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../src/client/components";
import { DisplayReplyContext, DisplaySpec } from "../src/client/DisplaySpec";
import { compactMarkdown } from "../src/client/preview";
import { checkDisplay } from "../src/server/display-check";
import { displayFixtures } from "./display-spec-fixtures";

const patch = (...lines: unknown[]) =>
  lines.map((line) => JSON.stringify(line)).join("\n");
const fence = (source: string) => "```spec\n" + source + "\n```";
const render = (
  content: string,
  props: { diagrams?: boolean; compact?: boolean } = {},
) => renderToStaticMarkup(<RichText content={content} {...props} />);

const report = fence(
  patch(
    { op: "add", path: "/root", value: "card" },
    {
      op: "add",
      path: "/elements/card",
      value: {
        type: "Card",
        props: { title: "Weekly deploys", subtitle: "Nov 9 to 15" },
        children: ["intro", "fields", "table", "actions"],
      },
    },
    {
      op: "add",
      path: "/elements/intro",
      value: { type: "Text", props: { content: "Deploys are **up 12%**." } },
    },
    {
      op: "add",
      path: "/elements/fields",
      value: { type: "Fields", children: ["f1", "f2"] },
    },
    {
      op: "add",
      path: "/elements/f1",
      value: { type: "Field", props: { label: "Deploys", value: "1,284" } },
    },
    {
      op: "add",
      path: "/elements/f2",
      value: { type: "Field", props: { label: "Failures", value: 3 } },
    },
    {
      op: "add",
      path: "/elements/table",
      value: {
        type: "Table",
        props: {
          headers: ["Project", "Deploys"],
          rows: [["web", "412"]],
          align: ["left", "right"],
          caption: "By project",
        },
      },
    },
    {
      op: "add",
      path: "/elements/actions",
      value: { type: "Actions", children: ["open"] },
    },
    {
      op: "add",
      path: "/elements/open",
      value: {
        type: "LinkButton",
        props: { label: "Open dashboard", url: "https://example.com/d" },
      },
    },
  ),
);

it("draws a display inside prose, keeping the surrounding answer", () => {
  const html = render(`Here is the report:\n\n${report}\n\nLet me know.`);
  expect(html).toContain("<p>Here is the report:</p>");
  expect(html).toContain("<p>Let me know.</p>");
  expect(html).toContain('<h3 class="display-title">Weekly deploys</h3>');
  expect(html).toContain("Nov 9 to 15");
  expect(html).toContain("<strong>up 12%</strong>");
  expect(html).toContain("<dt>Deploys</dt><dd>1,284</dd>");
  expect(html).toContain("<dt>Failures</dt><dd>3</dd>");
  expect(html).toContain("<caption>By project</caption>");
  expect(html).toContain('<th scope="col" class="align-right">Deploys</th>');
  expect(html).toContain('<td class="align-right">412</td>');
  expect(html).toContain('role="region"');
  expect(html).not.toContain("language-spec");
  expect(html).not.toContain("&quot;op&quot;");
});

it("opens a LinkButton in a new tab without leaking the opener", () => {
  const html = render(report);
  expect(html).toContain(
    '<a class="display-link-button" href="https://example.com/d" target="_blank" rel="noopener noreferrer">Open dashboard</a>',
  );
});

it("refuses a javascript: link and still draws the rest", () => {
  const html = render(
    fence(
      patch(
        { op: "add", path: "/root", value: "s" },
        {
          op: "add",
          path: "/elements/s",
          value: { type: "Section", children: ["bad", "ok"] },
        },
        {
          op: "add",
          path: "/elements/bad",
          value: {
            type: "LinkButton",
            props: { label: "Go", url: "javascript:alert(1)" },
          },
        },
        {
          op: "add",
          path: "/elements/ok",
          value: { type: "Text", props: { content: "still here" } },
        },
      ),
    ),
  );
  expect(html).not.toContain("javascript:");
  expect(html).toContain("This part of the display could not be shown");
  expect(html).toContain("still here");
});

it("draws one bad element as a placeholder and keeps its siblings", () => {
  const html = render(
    fence(
      patch(
        { op: "add", path: "/root", value: "s" },
        {
          op: "add",
          path: "/elements/s",
          value: { type: "Section", children: ["a", "b", "c"] },
        },
        { op: "add", path: "/elements/a", value: { type: "Divider" } },
        {
          op: "add",
          path: "/elements/b",
          value: { type: "Button", props: { id: "x", label: "Approve" } },
        },
        {
          op: "add",
          path: "/elements/c",
          value: { type: "Text", props: { content: "after" } },
        },
      ),
    ),
  );
  expect(html).toContain("Button is not supported here");
  expect(html).toContain("after");
  expect(html).toContain("<hr");
  expect(html).not.toContain("Approve");
});

it("shows the source when the block can't be drawn", () => {
  const source = patch({
    op: "add",
    path: "/elements/a",
    value: { type: "Divider" },
  });
  const html = render(`Before\n\n${fence(source)}\n\nAfter`);
  expect(html).toContain(
    "This display could not be drawn. Its source is below.",
  );
  expect(html).toContain("<pre><code");
  expect(html).toContain("&quot;/elements/a&quot;");
  expect(html).toContain("<p>Before</p>");
  expect(html).toContain("<p>After</p>");
});

it("draws Text content as Markdown with displays and diagrams turned off", () => {
  const inner = fence(
    patch(
      { op: "add", path: "/root", value: "x" },
      { op: "add", path: "/elements/x", value: { type: "Divider" } },
    ),
  );
  const html = render(
    fence(
      patch(
        { op: "add", path: "/root", value: "t" },
        {
          op: "add",
          path: "/elements/t",
          value: {
            type: "Text",
            props: { content: `${inner}\n\n[link](https://example.com)` },
          },
        },
      ),
    ),
  );
  expect(html).not.toContain("<hr");
  expect(html).toContain("language-spec");
  expect(html).toContain('href="https://example.com"');
  expect(html.match(/class="display-spec"/g)).toHaveLength(1);
});

it("leaves a spec block as code when diagrams are off, as for GitHub content", () => {
  const html = render(report, { diagrams: false });
  expect(html).toContain("language-spec");
  expect(html).not.toContain("display-spec");
});

it("renders other fenced blocks exactly as before", () => {
  const html = render('```json\n{"a":1}\n```\n\n```text\nplain\n```');
  expect(html).toBe(
    '<div class="markdown"><pre><code class="language-json">{&quot;a&quot;:1}\n</code></pre>\n<pre><code class="language-text">plain\n</code></pre></div>',
  );
});

it("escapes markup in every value instead of drawing it", () => {
  const html = render(
    fence(
      patch(
        { op: "add", path: "/root", value: "c" },
        {
          op: "add",
          path: "/elements/c",
          value: {
            type: "Card",
            props: { title: "<img src=x onerror=alert(1)>" },
            children: ["f"],
          },
        },
        {
          op: "add",
          path: "/elements/f",
          value: {
            type: "Field",
            props: { label: "<script>x</script>", value: "<b>v</b>" },
          },
        },
      ),
    ),
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

it("keeps a long spec block whole in a compact preview", () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({
    op: "add",
    path: `/elements/d${i}`,
    value: { type: "Divider" },
  }));
  const html = render(
    fence(
      patch(
        { op: "add", path: "/root", value: "s" },
        {
          op: "add",
          path: "/elements/s",
          value: {
            type: "Section",
            children: Array.from({ length: 40 }, (_, i) => `d${i}`),
          },
        },
        ...lines,
      ),
    ),
    { compact: true },
  );
  expect(html.match(/<hr/g)).toHaveLength(40);
  expect(typeof compactMarkdown).toBe("function");
});

it("cuts a fallback block's source to ten lines in a compact preview", () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({
    op: "add",
    path: `/elements/d${i}`,
    value: { type: "Divider" },
  }));
  // No root, so the block falls back to its source.
  const source = fence(patch(...lines));
  const compact = render(source, { compact: true });
  expect(compact).toContain(
    "This display could not be drawn. Its source is below.",
  );
  expect(compact).toContain("/elements/d9&quot;");
  expect(compact).not.toContain("/elements/d10&quot;");
  const full = render(source);
  expect(full).toContain("/elements/d39&quot;");
});

it("draws or falls back at the source size limit as the reader does", () => {
  const at = displayFixtures.find((f) => f.name === "source at the size limit");
  const over = displayFixtures.find(
    (f) => f.name === "source over the size limit",
  );
  const atHtml = render(fence(at!.source));
  expect(atHtml).toContain('class="display-spec"');
  expect(atHtml).not.toContain("This display could not be drawn");
  expect(render("```spec\n" + at!.source)).toContain('class="display-spec"');
  const crlfSource = at!.source.replaceAll("\n", "\r\n");
  const crlfFence = (source: string) =>
    "  ~~~spec\r\n" +
    source
      .split("\r\n")
      .map((line) => "  " + line)
      .join("\r\n") +
    "\r\n  ~~~";
  const crlfAt = crlfFence(crlfSource.slice(0, at!.source.length));
  const crlfOver = crlfFence(crlfSource);
  for (const prefix of ["", "\uFEFF"]) {
    expect(checkDisplay(prefix + crlfAt)).toContain("Display valid.");
    expect(render(prefix + crlfAt)).toContain('class="display-spec"');
    expect(checkDisplay(prefix + crlfOver)).toContain("Block exceeds");
    expect(render(prefix + crlfOver)).toContain(
      "This display could not be drawn",
    );
  }
  const overHtml = render(fence(over!.source));
  expect(overHtml).not.toContain('class="display-spec"');
  expect(overHtml).toContain("This display could not be drawn");
});

it("checks and draws a text explanation alongside a link in Actions", () => {
  const source = fence(
    patch(
      { op: "add", path: "/root", value: "actions" },
      {
        op: "add",
        path: "/elements/actions",
        value: { type: "Actions", children: ["details", "link"] },
      },
      {
        op: "add",
        path: "/elements/details",
        value: { type: "Text", props: { content: "Read the full report." } },
      },
      {
        op: "add",
        path: "/elements/link",
        value: {
          type: "LinkButton",
          props: { label: "Open report", url: "https://example.com/report" },
        },
      },
    ),
  );
  expect(checkDisplay(source)).toContain("Display valid. Elements: 3.");
  const html = render(source);
  expect(html).toContain("Read the full report.");
  expect(html).toContain('href="https://example.com/report"');
});

it("checks and draws ReplyButton elements and pre-fills the reply handler only when interactive", () => {
  const raw = patch(
    { op: "add", path: "/root", value: "actions" },
    {
      op: "add",
      path: "/elements/actions",
      value: { type: "Actions", children: ["same", "custom"] },
    },
    {
      op: "add",
      path: "/elements/same",
      value: { type: "ReplyButton", props: { label: "Run benchmark" } },
    },
    {
      op: "add",
      path: "/elements/custom",
      value: {
        type: "ReplyButton",
        props: {
          label: "Compare staging",
          prompt: "Compare these metrics with staging.",
        },
      },
    },
  );
  const source = fence(raw);
  expect(checkDisplay(source)).toContain("Display valid. Elements: 3.");

  // Without a DisplayReplyContext provider, ReplyButton renders disabled.
  const disabledHtml = render(source);
  expect(disabledHtml).toContain(
    '<button type="button" class="display-reply-button" disabled="">Run benchmark</button>',
  );
  expect(disabledHtml).toContain(
    '<button type="button" class="display-reply-button" disabled="" title="Compare these metrics with staging.">Compare staging</button>',
  );

  // With a DisplayReplyContext provider in a non-compact, finished message, ReplyButton is enabled.
  const onReply = vi.fn();
  const enabledHtml = renderToStaticMarkup(
    <DisplayReplyContext.Provider value={onReply}>
      <RichText content={source} />
    </DisplayReplyContext.Provider>,
  );
  expect(enabledHtml).toContain(
    '<button type="button" class="display-reply-button">Run benchmark</button>',
  );
  expect(enabledHtml).toContain(
    '<button type="button" class="display-reply-button" title="Compare these metrics with staging.">Compare staging</button>',
  );

  // In compact previews or while writing, ReplyButton remains disabled even inside a provider.
  const compactHtml = renderToStaticMarkup(
    <DisplayReplyContext.Provider value={onReply}>
      <RichText content={source} compact />
    </DisplayReplyContext.Provider>,
  );
  expect(compactHtml).toContain('class="display-reply-button" disabled=""');

  const writingHtml = renderToStaticMarkup(
    <DisplayReplyContext.Provider value={onReply}>
      <RichText content={source} writing />
    </DisplayReplyContext.Provider>,
  );
  expect(writingHtml).toContain('class="display-reply-button" disabled=""');

  // Clicking an active ReplyButton invokes the context callback with prompt ?? label.
  let capturedTree: ReactNode = null;
  function Capture() {
    capturedTree = DisplaySpec({ source: raw, markdown: (text) => text });
    return <>{capturedTree}</>;
  }
  renderToStaticMarkup(
    <DisplayReplyContext.Provider value={onReply}>
      <Capture />
    </DisplayReplyContext.Provider>,
  );
  const buttons: ReactElement<{
    onClick?: () => void;
    disabled?: boolean;
  }>[] = [];
  const collectButtons = (node: ReactNode): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(collectButtons);
      return;
    }
    if (isValidElement(node)) {
      const el = node as ReactElement<{
        children?: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
      }>;
      if (typeof el.type === "function") {
        collectButtons((el.type as (props: unknown) => ReactNode)(el.props));
        return;
      }
      if (el.type === "button") buttons.push(el);
      if (el.props.children) collectButtons(el.props.children);
    }
  };
  collectButtons(capturedTree);
  expect(buttons).toHaveLength(2);
  buttons[0]!.props.onClick?.();
  buttons[1]!.props.onClick?.();
  expect(onReply).toHaveBeenNthCalledWith(1, "Run benchmark");
  expect(onReply).toHaveBeenNthCalledWith(
    2,
    "Compare these metrics with staging.",
  );
});

it("checks and draws a standalone display nested in a quote or list item", () => {
  const source = fence(
    patch(
      { op: "add", path: "/root", value: "details" },
      {
        op: "add",
        path: "/elements/details",
        value: { type: "Text", props: { content: "Nested display." } },
      },
    ),
  );
  const lines = source.split("\n");
  const quoted = lines.map((line) => "> " + line).join("\n");
  const listed = lines
    .map((line, index) => (index === 0 ? "- " : "  ") + line)
    .join("\n");
  for (const nested of [quoted, listed]) {
    expect(checkDisplay(nested)).toContain("Display valid. Elements: 1.");
    expect(render(nested)).toContain('class="display-spec"');
  }
  const quotePrefix = "> ".repeat(32);
  const padded = [
    ...lines.slice(0, -1),
    ...Array<string>(5_500).fill(""),
    lines.at(-1)!,
  ]
    .map((line) => quotePrefix + line)
    .join("\n");
  expect(padded.length).toBeGreaterThan(5 * 65_536 + 256);
  expect(checkDisplay(padded)).toContain("Display valid. Elements: 1.");
  expect(render(padded)).toContain('class="display-spec"');
  expect(checkDisplay(" ".repeat(512 * 1024 + 1))).toContain(
    "Submit the patch lines directly without Markdown wrappers.",
  );
});

it("cuts a spec fence to ten lines in a compact preview with displays off", () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({
    op: "add",
    path: `/elements/d${i}`,
    value: { type: "Divider" },
  }));
  const html = render(
    fence(patch({ op: "add", path: "/root", value: "d0" }, ...lines)),
    { compact: true, diagrams: false },
  );
  expect(html).not.toContain('class="display-spec"');
  expect(html).toContain("/elements/d8&quot;");
  expect(html).not.toContain("/elements/d9&quot;");
});
