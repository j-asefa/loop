/**
 * Tap a feed card the way a person opens it, ending where tapping a card
 * used to: in its reading sheet or its thread. A Done result or reply first
 * opens in place (B3); its "Open full thread" then opens the sheet and the
 * card closes again. Other cards open their sheet or thread directly.
 *
 * `row` is the card's `.feed-row` (or a locator for that button).
 */
export async function openCardReading(row) {
  const card = row.locator(
    "xpath=ancestor-or-self::article[contains(@class,'feed-item-card')][1]",
  );
  // Held before the tap: a card that leaves the page (its tap navigated)
  // is then read from its detached element at once, not waited for.
  const element = await card.elementHandle();
  await row.click();
  // React commits the open state within a frame or two of the tap.
  const opened = await element
    .evaluate(
      (element) =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(element.dataset.expanded === "true"),
            ),
          ),
        ),
    )
    .catch(() => false);
  if (opened)
    await card
      .getByRole("button", { name: "Open full thread", exact: false })
      .first()
      .click();
}
