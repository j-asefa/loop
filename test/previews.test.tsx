import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactCard, ResultPreview } from "../src/client/components";
import type { ResultCard } from "../src/shared/cards";
import { ContentCard } from "../src/client/ContentCard";
import type { Artifact } from "../src/shared/types";
import {
  structuredPreview,
  safePreviewLink,
  webPreview,
} from "../src/client/preview";
const card = (content: string, kind = "markdown", metadata = "{}") =>
  renderToStaticMarkup(
    <ArtifactCard
      connections={[]}
      item={
        {
          id: "preview",
          title: "Preview",
          content,
          kind,
          metadata,
          created_at: 0,
        } as Artifact
      }
      onOpen={() => {}}
      onProfile={() => {}}
    />,
  );
it("preserves complete links and emphasis beyond the former 650 character cutoff", () => {
  const lead = "A full paragraph with context. ".repeat(21);
  const html = card(
    lead +
      "**Complete emphasis** and [Original source](https://example.com/article?first=yes&second=true).\n\n```typescript\nconst result = { complete: true };\n```",
  );
  expect(html).toContain("<strong>Complete emphasis</strong>");
  expect(html).toContain(
    'href="https://example.com/article?first=yes&amp;second=true"',
  );
  expect(html).toContain("const result = { complete: true };");
});
it("renders the reported Playwright JSON result as readable linked entries and never an unsafe link", () => {
  const content =
    "### Result\n" +
    JSON.stringify([
      {
        title: "Nokia Design Archive",
        url: "https://example.com/archive",
        details: "68 points · 25 comments",
      },
      { title: "Unsafe URL", url: "javascript:alert(1)" },
    ]) +
    "\n\n### Ran Playwright code\n```js\nawait page.evaluate();\n```";
  expect(structuredPreview(content)).toHaveLength(2);
  const html = card(
    content,
    "markdown",
    JSON.stringify({ tool: "browser_run_code_unsafe" }),
  );
  expect(html).toContain('href="https://example.com/archive"');
  expect(html).toContain("68 points · 25 comments");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("await page.evaluate");
  expect(safePreviewLink("data:text/html,unsafe")).toBeUndefined();
});
it("renders table, code and image previews in their native forms without mutating the full content", () => {
  expect(
    card(
      JSON.stringify({ columns: ["Name", "Count"], rows: [["Apples", 3]] }),
      "table",
    ),
  ).toContain("<td>Apples</td>");
  const html = card("# This is code\nconst x = '<script>';", "code");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<h1>");
  expect(
    card(JSON.stringify({ mimeType: "image/png", data: "aGVsbG8=" }), "image"),
  ).toContain("data:image/png;base64,aGVsbG8=");
});
it("turns fetched Exa pages into a title, source and excerpt without repository metadata or repeated headings", () => {
  const content =
    "# agent-substrate/substrate\nURL: https://github.com/agent-substrate/substrate\n\n# agent-substrate/substrate\n\nAgent Substrate: the core system\n\n- Stars: 1593\n- Forks: 264\n\n## Languages\n\n- Go\n- Python\n\n## README\n\nNOTE: This is not an officially supported Google product.\n\n## What is Agent Substrate?\n\nAgent Substrate delivers a performant, high density runtime environment for large scale agent deployments.";
  const preview = webPreview(content, "web_fetch_exa")!;
  expect(preview.title).toBe("agent-substrate/substrate");
  expect(preview.pages[0].excerpt).toBe(
    "Agent Substrate delivers a performant, high density runtime environment for large scale agent deployments.",
  );
  const html = card(
    content,
    "markdown",
    JSON.stringify({ tool: "web_fetch_exa" }),
  );
  expect(html).toContain('class="web-result-source"');
  expect(html.match(/<h2>agent-substrate\/substrate<\/h2>/g)).toHaveLength(1);
  for (const clutter of [
    "URL:",
    "Stars:",
    "Forks:",
    "Languages",
    "web_fetch_exa result",
  ])
    expect(html).not.toContain(clutter);
});
it("renders search matches without scores or request metadata and preserves safe source links", () => {
  const content = JSON.stringify({
    requestId: "opaque-request",
    costDollars: 0.001,
    results: [
      {
        title: "First result",
        url: "https://example.com/first",
        score: 0.98,
        text: "A useful introduction to the first search result, with enough detail to understand it.",
      },
      { title: "Unsafe result", url: "javascript:alert(1)", text: "bad" },
    ],
  });
  const html = card(
    content,
    "markdown",
    JSON.stringify({ tool: "web_search_exa" }),
  );
  expect(html).toContain("Search results");
  expect(html).toContain('href="https://example.com/first"');
  expect(html).toContain("A useful introduction");
  expect(html).not.toContain("opaque-request");
  expect(html).not.toContain("0.98");
  expect(html).not.toContain("javascript:");
});
it("preserves title-based web previews for historical typed results without a tool field", () => {
  const html = renderToStaticMarkup(
    <ResultPreview
      card={
        {
          source: { artifact_id: "historical" },
          title: "web_search_exa result",
          kind: "markdown",
          content: JSON.stringify({
            requestId: "private-request",
            results: [
              {
                title: "Historical link",
                url: "https://example.com/history",
                text: "Useful historical excerpt.",
              },
            ],
          }),
          display: { tool: null },
        } as ResultCard
      }
    />,
  );
  expect(html).toContain('class="web-result-source"');
  expect(html).toContain('href="https://example.com/history"');
  expect(html).toContain("Useful historical excerpt.");
  expect(html).not.toContain("private-request");
});
it("accepts provider highlights as either strings or arrays without crashing the card", () => {
  for (const highlights of [
    "Human excerpt",
    ["Human excerpt", 10, null],
    { unexpected: true },
    7,
  ]) {
    const content = JSON.stringify({
      results: [{ url: "https://example.com", title: "Example", highlights }],
    });
    expect(() =>
      card(content, "markdown", JSON.stringify({ tool: "web_search_exa" })),
    ).not.toThrow();
    if (typeof highlights === "string" || Array.isArray(highlights))
      expect(webPreview(content, "web_search_exa")?.pages[0].excerpt).toBe(
        "Human excerpt",
      );
  }
});

it.each([
  ["web_search_exa result", "markdown", null, "Web search", "Search results"],
  ["web_fetch_exa result", "markdown", null, "Webpage", "Example"],
  [
    "browser_run_code_unsafe result",
    "markdown",
    "browser_run_code_unsafe",
    "Tool result",
    "Browser result",
  ],
  [
    "demo_tool result",
    "markdown",
    "demo_tool",
    "Tool result",
    "demo tool result",
  ],
])(
  "keeps the typed card classification and heading for %s",
  (title, kind, tool, eyebrow, heading) => {
    const result: ResultCard = {
      id: "a:presentation",
      type: "result",
      title: title!,
      kind: kind!,
      content: JSON.stringify({
        results: [
          { title: "Example", url: "https://example.com", text: "An excerpt." },
        ],
      }),
      source: {
        artifact_id: "presentation",
        message_id: null,
        conversation_id: null,
        run_id: null,
      },
      author: {
        kind: "agent",
        id: "writer",
        name: "Writer",
        provider: "openai",
      },
      recipient: null,
      context: {
        conversation_title: null,
        folder_id: null,
        project_id: null,
        project_name: null,
        team_id: null,
      },
      format: "markdown",
      created_at: 1,
      updated_at: null,
      saved: false,
      attachments: [],
      href: "/?artifact=presentation",
      version: 1,
      hidden: false,
      display: {
        model: null,
        tool,
        partial: false,
        imported: false,
        uploaded: false,
        mime: null,
        filename: null,
        size: null,
        text: false,
        download: null,
        source: null,
        refreshable: false,
        app: false,
      },
    };
    const html = renderToStaticMarkup(
      <ContentCard card={result} onOpen={() => {}} />,
    );
    expect(html).toContain(`<span class="eyebrow">${eyebrow}</span>`);
    expect(html).toContain(`<h2>${heading}</h2>`);
  },
);
