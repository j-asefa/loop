import { beforeAll, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../src/client/components";
import { loadMarkdownMath } from "../src/client/markdownMath";

beforeAll(() => loadMarkdownMath());

function render(content: string, compact = false) {
  return renderToStaticMarkup(<RichText content={content} compact={compact} />);
}

it("renders the screenshot's inline formulas inside the shared message renderer", () => {
  const html = render(String.raw`1. **The Claim:** Fixed-width $k$-CNF in time
($\sim 2^{n \cdot (\log \log n)^2 / \sqrt{\log n}}$),
instead of $2^{\Omega(n)}$; the bound is $T$.`);
  expect(html.match(/class="katex"/g)).toHaveLength(4);
  expect(html).toContain("<ol>");
  expect(html).toContain("<strong>The Claim:</strong>");
  expect(html).toContain('<annotation encoding="application/x-tex">');
  expect(html).toContain("<msup>");
  expect(html).toContain("<msqrt>");
  expect(html).not.toContain("katex-error");
});

it("renders display math and math fences alongside GFM tables and links", () => {
  const html = render(String.raw`$$
\frac{a}{b}
$$

~~~math
\sum_{i=1}^{n} i
~~~

| Bound | Meaning |
| --- | --- |
| $n^2$ | Quadratic |

[Source](https://example.com/math)`);
  expect(html.match(/class="katex-display"/g)).toHaveLength(2);
  expect(html.match(/class="katex"/g)).toHaveLength(3);
  expect(html).toContain('class="table-scroll"');
  expect(html).toContain('href="https://example.com/math"');
  expect(html).toContain('rel="noopener noreferrer"');
});

it.each(["``` math", "~~~\tmath", "~~~ \tmath"])(
  "renders a dollar-free math fence with whitespace before its language: %s",
  (opening) => {
    const html = render(`${opening}\n\\frac{1}{2}\n${opening.slice(0, 3)}`);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("<pre>");
  },
);

it.each([
  "Costs $5 and $10.",
  "Costs $5–$10.",
  "Literal $ spaced words $ stay prose.",
  String.raw`Escaped \$x\$ and \$5.`,
  "`$x$`\n\n```js\nconst price = '$5'; const other = '$10';\n```",
])("keeps currency, escapes and ordinary code literal: %s", (content) => {
  const html = render(content);
  expect(html).not.toContain('class="katex');
  expect(html).not.toContain("language-math");
  expect(html).toContain("$");
});

it("keeps numeric math and math next to escaped currency", () => {
  const html = render(String.raw`Pay \$5; then compute $2^n$ and $5$.`);
  expect(html.match(/class="katex"/g)).toHaveLength(2);
  expect(html).toContain("Pay $5;");
});

it("preserves emphasis and later equations after unescaped currency", () => {
  const html = render("Costs $5 **or** $10; calculate $x^2$ afterward.");
  expect(html).toContain("Costs $5 <strong>or</strong> $10;");
  expect(html.match(/class="katex"/g)).toHaveLength(1);
  expect(html).toContain("afterward.");
});

it("does not let a price consume the delimiter inside a following code span", () => {
  const html = render("Prices are $5 and $10. Code: `$x$`. Then $y^2$.");
  expect(html).toContain("Prices are $5 and $10. Code: <code>$x$</code>.");
  expect(html.match(/class="katex"/g)).toHaveLength(1);
});

it("keeps incomplete and malformed equations readable and renders the completed update", () => {
  expect(render(String.raw`Working $\frac{1}{`)).toContain(
    String.raw`Working $\frac{1}{`,
  );
  const malformed = render(String.raw`Before $\frac{1}{$ after.`);
  expect(malformed).toContain("katex-error");
  expect(malformed).toContain(String.raw`\frac{1}{`);
  expect(malformed).toContain("after.");
  const completed = render(String.raw`Working $\frac{1}{2}$ done.`);
  expect(completed).toContain('class="katex"');
  expect(completed).not.toContain("katex-error");
});

it("does not allow math to introduce links, external images or HTML attributes", () => {
  const html = render(String.raw`$\href{javascript:alert(1)}{click}$

$\includegraphics{https://example.com/tracking.png}$

$\htmlClass{injected}{x}$

<script>alert(1)</script>`);
  expect(html).not.toMatch(/<(?:a|img|script)\b/);
  expect(html).not.toContain('class="injected"');
  expect(html).not.toContain('src="https://example.com');
});

it("bounds recursive macros without breaking the rest of the message", () => {
  const html = render(String.raw`$\def\loop{\loop}\loop$ safe tail`);
  expect(html).toContain("katex-error");
  expect(html).toContain("safe tail");
});

it("renders complete math fences in compact cards while preserving block limits", () => {
  const equation = [
    "```math",
    String.raw`\begin{aligned}`,
    ...Array.from({ length: 12 }, (_, i) => String.raw`a_{${i}} &= ${i} \\`),
    String.raw`\end{aligned}`,
    "```",
  ].join("\n");
  const html = render(
    equation +
      "\n\n" +
      Array.from({ length: 7 }, (_, i) => `Block ${i}`).join("\n\n"),
    true,
  );
  expect(html).toContain('class="katex-display"');
  expect(html).not.toContain("katex-error");
  expect(html).toContain("Block 4");
  expect(html).not.toContain("Block 5");
});
