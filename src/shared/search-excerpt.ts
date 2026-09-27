export function searchTerms(query: string) {
  return [
    ...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []),
  ].slice(0, 20);
}

export function searchExcerpt(
  content: string,
  title: string,
  query: string,
  length = 320,
) {
  let text = content
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[\s#>*-]+/gm, "")
    .replace(/[`*]/g, "")
    // Preserve identifiers such as web_fetch_exa while removing emphasis.
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const heading = title
    .replace(/[*`#]/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .trim();
  if (heading && text.toLowerCase().startsWith(heading.toLowerCase()))
    text = text.slice(heading.length).trim();
  if (!text) return "";
  const positions = searchTerms(query)
    .map((word) => text.toLowerCase().indexOf(word))
    .filter((i) => i >= 0);
  const match = positions.length ? Math.min(...positions) : 0;
  let start = Math.max(0, match - 80);
  if (start) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < match) start = space + 1;
  }
  return (
    (start ? "…" : "") +
    text.slice(start, start + length).trim() +
    (start + length < text.length ? "…" : "")
  );
}
