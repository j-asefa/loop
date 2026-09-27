import type { CatalogEntry } from "../shared/mcp-catalog";

const featured = [
  "github",
  "playwright",
  "exa",
  "context7",
  "slack",
  "notion",
  "linear",
  "brave-search",
  "deepwiki",
];
export function catalogResults(
  entries: CatalogEntry[],
  query: string,
  category: string,
  noAccount: boolean,
) {
  const q = query.trim().toLowerCase();
  const score = (entry: CatalogEntry) => {
    const name = entry.name.toLowerCase();
    const relevance = !q
      ? 0
      : name === q
        ? 100
        : name.startsWith(q)
          ? 80
          : name.includes(q)
            ? 60
            : entry.publisher.toLowerCase().includes(q)
              ? 40
              : 20;
    const index = featured.indexOf(entry.id);
    return relevance + (index === -1 ? 0 : (featured.length - index) / 10);
  };
  return entries
    .filter(
      (entry) =>
        !/\bdeprecated\b/i.test(`${entry.description} ${entry.note || ""}`) &&
        (category === "All" || entry.category === category) &&
        (!noAccount || entry.auth === "none") &&
        `${entry.name} ${entry.publisher} ${entry.description} ${entry.category}`
          .toLowerCase()
          .includes(q),
    )
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
