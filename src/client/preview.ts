// Parse complete data, never a character-truncated JSON/Markdown fragment.
export function structuredPreview(content: string): unknown {
  const text = content.trim();
  const result = /^#{1,6} Result\s*\n([\s\S]*?)(?=\n#{1,6} |$)/
    .exec(text)?.[1]
    ?.trim();
  const candidate = result || text;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(candidate)?.[1];
  const json = fenced || candidate;
  if (!/^[\[{]/.test(json.trim())) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
export function safePreviewLink(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function browserPreview(content: string) {
  const url = safePreviewLink(/^- Page URL:\s*(.+)$/m.exec(content)?.[1]);
  const title = /^- Page Title:\s*(.+)$/m.exec(content)?.[1];
  return url ? { url, title: title || new URL(url).hostname } : undefined;
}

function webExcerpt(value: unknown, title: string) {
  if (typeof value !== "string") return "";
  const paragraphs = value
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(
      (block) =>
        block &&
        !/^(?:#{1,6}\s|[-*]\s|\d+[.)]\s|```|[-*_]{3,}$|URL:|Title:|License\b|Copyright\b|NOTE:)/i.test(
          block,
        ),
    )
    .map((block) =>
      block
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((block) => block && block.toLowerCase() !== title.toLowerCase());
  const excerpt = paragraphs.find((p) => p.length >= 60) || paragraphs[0] || "";
  return excerpt.length > 230
    ? excerpt.slice(0, 230).replace(/\s+\S*$/, "") + "…"
    : excerpt;
}

export function webPreview(content: string, tool?: string) {
  if (
    !tool ||
    !/(?:web_(?:search|fetch)|exa|tavily|brave|firecrawl|webpage|fetch_url)/i.test(
      tool,
    )
  )
    return undefined;
  const data: any = structuredPreview(content);
  const candidates = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.pages)
        ? data.pages
        : data?.url
          ? [data]
          : [];
  let pages: { url: string; title: string; excerpt: string }[] =
    candidates.flatMap((row: any) => {
      const url = safePreviewLink(row?.url || row?.link);
      if (!url) return [];
      const title =
        typeof row.title === "string" ? row.title : new URL(url).hostname;
      return [
        {
          url,
          title,
          excerpt: webExcerpt(
            row.summary ||
              row.description ||
              row.snippet ||
              row.text ||
              row.content ||
              (Array.isArray(row.highlights)
                ? row.highlights
                    .filter((text: unknown) => typeof text === "string")
                    .join("\n\n")
                : typeof row.highlights === "string"
                  ? row.highlights
                  : ""),
            title,
          ),
        },
      ];
    });
  if (!pages.length)
    pages = content
      .split(/(?=^(?:Title:|#{1,6} [^\n]+\nURL:))/m)
      .flatMap((block) => {
        const url = safePreviewLink(/^URL:\s*(\S+)/im.exec(block)?.[1]);
        if (!url) return [];
        const title =
          /^(?:Title:\s*|#{1,6}\s+)(.+)$/im.exec(block)?.[1]?.trim() ||
          new URL(url).hostname;
        return [{ url, title, excerpt: webExcerpt(block, title) }];
      });
  if (!pages.length) return undefined;
  const search = pages.length > 1 || /search/i.test(tool);
  return {
    title: search ? "Search results" : pages[0].title,
    search,
    pages: pages.slice(0, 3),
  };
}
// Trim whole Markdown blocks after parsing. Inline links, emphasis and fences
// retain their structure even when a preview ends before the complete answer.
export function compactMarkdown() {
  return (tree: any) => {
    tree.children = tree.children.slice(0, 6);
    for (const node of tree.children) {
      if (node.type === "list") node.children = node.children.slice(0, 5);
      if (node.type === "table") node.children = node.children.slice(0, 5);
      if (node.type === "code" && node.lang !== "mermaid")
        node.value = node.value.split("\n").slice(0, 10).join("\n");
    }
  };
}
