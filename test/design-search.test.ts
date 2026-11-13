import { McpCatalogEntryId } from "../src/shared/contract-ids.js";
import { expect, it } from "vitest";
import { catalogResults } from "../src/client/catalogSearch";
import { searchExcerpt } from "../src/shared/search-excerpt";
import type { CatalogEntry } from "../src/shared/mcp-catalog";

const entry = (
  id: string,
  name: string,
  description = "Useful tools",
): CatalogEntry => ({
  id: McpCatalogEntryId.parse(id),
  name,
  description,
  publisher: name,
  category: "Development",
  auth: "none",
  inputs: [],
  transport: "http",
  source: "https://example.com",
});
it("ranks the exact product above incidental mentions and excludes deprecated integrations", () => {
  const entries = [
    entry("old", "Old docs", "DEPRECATED GitHub docs integration"),
    entry("docs", "Docs", "Documentation from GitHub"),
    entry("github", "GitHub"),
    entry("playwright", "Playwright"),
  ];
  expect(
    catalogResults(entries, "github", "All", false).map((e) => e.id),
  ).toEqual(["github", "docs"]);
  expect(catalogResults(entries, "", "Research", false)).toEqual([]);
  expect(
    catalogResults([{ ...entries[2], auth: "bearer" }], "", "All", true),
  ).toEqual([]);
  expect(catalogResults(entries, "", "All", false)[0].id).toBe("github");
});
it("shows the matching passage instead of the repeated title or beginning of a long document", () => {
  const result = searchExcerpt(
    "# Deployment report\n\n" +
      "Background information. ".repeat(30) +
      "The rollback preserved every project. More findings. ".repeat(20),
    "Deployment report",
    "rollback",
  );
  expect(result).toContain("rollback preserved");
  expect(result).not.toContain("Deployment report");
  expect(result.startsWith("…")).toBe(true);
  expect(result.endsWith("…")).toBe(true);
  expect(result.length).toBeLessThanOrEqual(322);
  expect(searchExcerpt("# Only a title", "Only a title", "title")).toBe("");
  expect(
    searchExcerpt(
      "Read [the guide](https://example.com) for details.",
      "Guide",
      "guide",
    ),
  ).toBe("Read the guide for details.");
});

it("preserves searchable identifiers and starts at a word before the earliest match", () => {
  const prefix = "background ".repeat(40);
  const result = searchExcerpt(
    prefix +
      "A very_long_identifier appears before rollback. " +
      "later ".repeat(80),
    "Report",
    "rollback very_long_identifier",
  );
  expect(result).toContain("very_long_identifier");
  expect(result.startsWith("…background ")).toBe(true);
  expect(
    searchExcerpt(
      "_Emphasis_ and __bold__ with `web_fetch_exa`",
      "Report",
      "web_fetch_exa",
    ),
  ).toBe("Emphasis and bold with web_fetch_exa");
  const earliest = searchExcerpt(
    prefix + "first " + "gap ".repeat(100) + "last",
    "Report",
    "last first",
  );
  expect(earliest).toContain("first");
  expect(earliest).not.toContain("last");
});

it("ranks product names above publisher and description matches", () => {
  const entries = [
    entry("description", "Alpha", "Works with Acme"),
    { ...entry("publisher", "Beta"), publisher: "Acme" },
    entry("name", "Acme tools"),
  ];
  expect(
    catalogResults(entries, "acme", "All", false).map((e) => e.id),
  ).toEqual(["name", "publisher", "description"]);
});
