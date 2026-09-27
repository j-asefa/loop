import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchExcerpt } from "../src/client/SearchExcerpt";

it("highlights literal, case-insensitive identifiers without rendering markup from the document", () => {
  expect(
    renderToStaticMarkup(
      <SearchExcerpt
        text="<script>WEB_FETCH_exa and web_fetch</script>"
        query="web_fetch WEB_fetch_exa"
      />,
    ),
  ).toBe(
    "&lt;script&gt;<mark>WEB_FETCH_exa</mark> and <mark>web_fetch</mark>&lt;/script&gt;",
  );
  expect(
    renderToStaticMarkup(<SearchExcerpt text="Nothing matched" query="?!" />),
  ).toBe("Nothing matched");
});
