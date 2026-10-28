import { expect } from "@playwright/test";
import { seedFeeds } from "./social-smoke.mjs";

export async function needsStackSmoke(page, fixture, capture) {
  seedFeeds(fixture.db, fixture.owner);
  await page.route("https://pictures.example/**", (route) => route.abort());
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  const feed = page.getByRole("region", { name: "Feed", exact: true });
  const needs = feed.getByRole("region", { name: "Needs you", exact: true });
  const filters = feed.getByRole("tablist", { name: "Show", exact: true });
  const tab = (name) =>
    filters.getByRole("tab", { name: new RegExp(`^${name}`) });
  const showAll = needs.getByRole("button", { name: "Show all", exact: true });
  const collapse = needs.getByRole("button", { name: "Collapse", exact: true });
  const onlyNeedsCards = async () => {
    await expect(needs).toContainText("3 need you");
    // No card from the selected Feed filter may remain visible alongside
    // the expanded attention cards.
    const visibleCards = feed.locator(
      ".approval-card:visible, .native-decision:visible, .scheduled-message:visible, .inbox-card-wrap:visible, .news-card:visible",
    );
    await expect(visibleCards).toHaveCount(3);
    expect(
      await visibleCards.evaluateAll((cards) =>
        cards.every((card) => card.closest(".needs-stack")),
      ),
    ).toBe(true);
    await expect(filters.getByRole("tab", { selected: true })).toHaveCount(0);
    await expect(feed.getByRole("button", { name: "Load more" })).toHaveCount(
      0,
    );
  };

  for (const [filter, state] of [
    ["Done", "completed"],
    ["Working", "running"],
    ["Queued", "queued"],
  ]) {
    await tab(filter).click();
    const selectedCard = feed.locator(".inbox-row").filter({
      hasText: fixture.conversations.find((c) => c.state === state).title,
    });
    await expect(selectedCard).toBeVisible();
    await showAll.click();
    await expect(collapse).toBeVisible();
    await onlyNeedsCards();
    if (filter === "Done") await capture("expanded-needs-only");
    await collapse.click();
    await expect(tab(filter)).toHaveAttribute("aria-selected", "true");
    await expect(selectedCard).toBeVisible();
  }

  // Selecting either the previous filter or a different one exits the
  // expanded view, even when the filter value itself does not change.
  await tab("Done").click();
  for (const filter of ["Done", "Working"]) {
    await showAll.click();
    await onlyNeedsCards();
    await tab(filter).click();
    await expect(collapse).toHaveCount(0);
    await expect(tab(filter)).toHaveAttribute("aria-selected", "true");
    await expect(feed.locator(".inbox-row:visible").first()).toBeVisible();
  }

  // Double-tapping Feed returns to Done, including when Done was already
  // selected behind the expanded stack.
  await tab("Done").click();
  await showAll.click();
  await onlyNeedsCards();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Feed", exact: true })
    .dblclick({ delay: 100 });
  await expect(collapse).toHaveCount(0);
  await expect(tab("Done")).toHaveAttribute("aria-selected", "true");
  await expect(feed.locator(".inbox-row:visible")).toHaveCount(2);

  // When only one attention card remains, folding automatically restores
  // the selected feed instead of leaving it hidden.
  await tab("Working").click();
  await showAll.click();
  await onlyNeedsCards();
  const failed = fixture.conversations.find((c) => c.state === "failed");
  const paused = fixture.conversations.find((c) => c.state === "paused");
  // Actions on Needs you cards still surface failures while the other feed
  // is hidden, and retrying does not reveal its cards.
  const dismissUrl = `**/api/runs/${failed.run}/dismiss`;
  let dismissals = 0;
  const recordDismissal = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/runs/${failed.run}/dismiss`
    )
      dismissals++;
  };
  page.on("request", recordDismissal);
  await page.route(dismissUrl, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Could not dismiss this card" },
    }),
  );
  await needs
    .locator(".inbox-card")
    .filter({ hasText: failed.title })
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Dismiss from Needs you", exact: true })
    .click();
  await expect(feed.getByRole("alert")).toContainText(
    "Could not dismiss this card",
  );
  await page.unroute(dismissUrl);
  const refreshed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/api/feed" &&
      url.searchParams.get("filter") === "working" &&
      response.status() === 200
    );
  });
  await feed.getByRole("button", { name: "Try again", exact: true }).click();
  await refreshed;
  await expect(feed.getByRole("alert")).toHaveCount(0);
  // The explicit refresh clears the notice without replaying the failed write.
  expect(dismissals).toBe(1);
  page.off("request", recordDismissal);
  await onlyNeedsCards();
  await fixture.api(`/runs/${failed.run}/dismiss`, {});
  fixture.db
    .prepare("UPDATE runs SET state='completed' WHERE id=?")
    .run(paused.run);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-source-refresh")),
  );
  await expect(collapse).toHaveCount(0);
  await expect(tab("Working")).toHaveAttribute("aria-selected", "true");
  await expect(feed.locator(".inbox-row:visible")).toHaveCount(1);

  // A host restart can interrupt an agent while its MCP call is awaiting
  // approval. The approval card must become a visible interruption card.
  const awaiting = fixture.conversations.find(
    (c) => c.state === "awaiting_approval",
  );
  fixture.db
    .prepare(
      "UPDATE runs SET state='interrupted',error='Host stopped before the merge finished.',updated_at=? WHERE id=?",
    )
    .run(Date.now(), awaiting.run);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("loop-source-refresh")),
  );
  const interrupted = needs
    .locator(".inbox-card")
    .filter({ hasText: awaiting.title });
  await expect(interrupted).toBeVisible();
  await expect(interrupted).toContainText(
    "Host stopped before the merge finished.",
  );
  await expect(needs.locator(".approval-card")).toHaveCount(0);
  const recovered = await fixture.api("/feed?filter=needs");
  expect(
    recovered.items.find((item) => item.run?.id === awaiting.run),
  ).toMatchObject({
    run: { state: "interrupted" },
    pending_approvals: 0,
    next_action: null,
  });

  // A connected source on an older version can still advertise a stale
  // approval action. That must not hide an interrupted thread in this UI.
  await page.route(/\/api\/feed\?/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.items ?? [])
      if (item.run?.id === awaiting.run)
        item.next_action = {
          kind: "approve",
          run_id: awaiting.run,
          message_id: null,
        };
    await route.fulfill({ response, json: body });
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(interrupted).toBeVisible();
  await capture("interrupted-approval-needs-you");
  await interrupted
    .getByRole("button", { name: "Thread actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Dismiss from Needs you", exact: true })
    .click();
  await expect(needs).toBeHidden();
  // Social now lives on Your profile. Its search remains available independently of
  // the Feed's Needs you stack.
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
  const socialTab = page
    .locator(".my-profile-tabs")
    .getByRole("tab", { name: /^Social(?:\s*\d+)?$/ });
  await expect(socialTab.locator(".chip-count")).toHaveText("3");
  await socialTab.click();
  await expect(
    page.locator(".news-card").filter({ hasText: "A faster build system" }),
  ).toBeVisible();
  await expect(page.locator(".needs-stack:visible")).toHaveCount(0);
  await page.locator(".social-options-toggle").click();
  await page
    .getByRole("searchbox", { name: "Search your feeds" })
    .fill("faster");
  await expect(page.locator(".news-card")).toHaveCount(1);
}
