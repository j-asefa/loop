import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Keep existing rows usable when a page repeats; only an explicit next click
// may request more. A duplicate-only page can still advance the server cursor.
export async function briefPaginationSmoke(
  page,
  { pattern, endpoint, first, remaining, more, rows, total },
) {
  assert.notEqual(first.before, null);
  assert.equal(remaining.before, null);
  const nextCursor =
    typeof first.before === "number" ? first.before - 1 : "fixture-next-cursor";
  const cursors = [];
  await page.route(pattern, (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get("before"));
    const body =
      cursors.length === 1
        ? first
        : cursors.length === 2
          ? { ...first, before: nextCursor }
          : remaining;
    return route.fulfill({ json: body });
  });
  try {
    for (let n = 1; n <= 3; n++) {
      const response = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname.endsWith(endpoint) && url.searchParams.has("before")
        );
      });
      await more.evaluate((button) => {
        button.click();
        button.click();
      });
      await response;
      await expect(rows).toHaveCount(n < 3 ? first.items.length : total);
      if (n < 3) await expect(more).toBeEnabled();
      else await expect(more).toHaveCount(0);
      assert.equal(
        cursors.length,
        n,
        "One page request per explicit interaction",
      );
    }
    assert.deepEqual(cursors, [
      String(first.before),
      String(first.before),
      String(nextCursor),
    ]);
  } finally {
    await page.unroute(pattern);
  }
}
