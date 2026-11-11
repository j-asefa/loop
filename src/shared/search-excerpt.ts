type SearchTermOptions = { limit?: number; exclude?: ReadonlySet<string> };
export function searchTerms(
  query: string,
  { limit = 20, exclude }: SearchTermOptions = {},
) {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])]
    .filter((term) => !exclude?.has(term))
    .slice(0, limit);
}
export function ftsQuery(
  query: string,
  {
    operator = "OR",
    prefix = false,
    ...terms
  }: SearchTermOptions & { operator?: "OR" | "AND"; prefix?: boolean } = {},
) {
  const words = searchTerms(query, terms);
  return words.length
    ? words
        .map((word) => `"${word.replaceAll('"', '""')}"${prefix ? "*" : ""}`)
        .join(` ${operator} `)
    : null;
}

export function searchExcerpt(
  content: string,
  title: string,
  query: string,
  length = 320,
): z.infer<typeof SearchExcerptSchema> {
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
import { z } from "zod";

// Excerpts are plain text, not HTML or ranges into the original document.
export const SearchExcerptSchema = z.string();
