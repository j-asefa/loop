import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function swipeBackSmoke(page, fixture, engine, capture) {
  const client =
    engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const dialog = () => page.locator("dialog[open]").last();
  const nav = (name) =>
    page.locator(".mobile-nav").getByRole("button", { name, exact: true });
  const swipe = async (
    target,
    dx = -170,
    dy = 0,
    cancelled = false,
    multi = false,
  ) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const x =
      dx > 0 ? Math.max(30, box.x + 30) : Math.min(350, box.x + box.width - 30);
    const y = Math.max(
      90,
      Math.min(page.viewportSize().height - 20, box.y + box.height / 2),
    );
    if (client) {
      const touches = (offsetX, offsetY) => [
        { x: x + offsetX, y: y + offsetY, id: 1 },
        ...(multi ? [{ x: x + offsetX - 20, y: y + offsetY + 10, id: 2 }] : []),
      ];
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: touches(0, 0),
      });
      for (let step = 1; step <= 8; step++) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: touches((dx * step) / 8, (dy * step) / 8),
        });
        await page.waitForTimeout(16);
      }
      await client.send("Input.dispatchTouchEvent", {
        type: cancelled ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    } else {
      // WebKit has no CDP touch injection; exercise the same TouchEvent path.
      await target.evaluate(
        (element, { x, y, dx, dy, cancelled, multi }) => {
          const send = (type, offsetX, offsetY) => {
            const touches = [
              {
                identifier: 1,
                target: element,
                clientX: x + offsetX,
                clientY: y + offsetY,
              },
            ];
            if (multi)
              touches.push({
                identifier: 2,
                target: element,
                clientX: x + offsetX - 20,
                clientY: y + offsetY + 10,
              });
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, "touches", {
              value:
                type === "touchend" || type === "touchcancel" ? [] : touches,
            });
            Object.defineProperty(event, "changedTouches", { value: touches });
            element.dispatchEvent(event);
          };
          send("touchstart", 0, 0);
          for (let step = 1; step <= 8; step++)
            send("touchmove", (dx * step) / 8, (dy * step) / 8);
          send(cancelled ? "touchcancel" : "touchend", dx, dy);
        },
        { x, y, dx, dy, cancelled, multi },
      );
    }
    await page.waitForTimeout(450);
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page.evaluate(() =>
      window.scrollTo({ top: 240, behavior: "instant" }),
    );
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(240);
    await nav("Running").tap();
    const heading = page.getByRole("heading", { name: "Running", exact: true });
    for (const [dx, dy, cancelled, multi] of [
      [-30, 0],
      [100, 0],
      [-10, -130],
      [-170, 0, true],
      [-170, 0, false, true],
    ]) {
      await swipe(heading, dx, dy, cancelled, multi);
      await expect(nav("Running")).toHaveAttribute("aria-current", "page");
    }
    await swipe(heading);
    await expect(nav("Feed")).toHaveAttribute("aria-current", "page");
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(240);
    await capture("swipe-back-feed");
    // Card headers are large tap targets. Swiping across one must go back,
    // rather than becoming a dead zone or also opening the agent's profile.
    await nav("Running").tap();
    await swipe(page.locator(".run-card .identity").first());
    await expect(nav("Feed")).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".profile-head")).toHaveCount(0);

    // The agent row owns its horizontal gestures, even when Feed has a Back
    // destination. Every agent remains reachable by touch and keyboard.
    await nav("Running").tap();
    await nav("Feed").tap();
    const strip = page.locator(".your-agents .agent-strip");
    assert(
      await strip.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
      "All agents must be available in a horizontal row",
    );
    await swipe(strip);
    await expect(nav("Feed")).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".profile-head")).toHaveCount(0);
    if (client)
      assert(
        await strip.evaluate((element) => element.scrollLeft > 0),
        "Swiping the agent row must reveal more agents",
      );
    const shortcuts = strip.getByRole("button");
    await shortcuts.first().focus();
    await expect(shortcuts.first()).toBeInViewport({ ratio: 1 });
    // macOS WebKit uses Option-Tab to include buttons in keyboard navigation.
    const tabKey =
      engine === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
    for (let index = 1; index < (await shortcuts.count()); index++)
      await page.keyboard.press(tabKey);
    await expect(shortcuts.last()).toBeFocused();
    await expect(shortcuts.last()).toBeInViewport({ ratio: 1 });
    const lastName = await shortcuts
      .last()
      .locator(".agent-shortcut-name")
      .textContent();
    await capture("your-agents-scrolled");
    await page.keyboard.press("Enter");
    await expect(page.locator(".profile-head h1")).toHaveText(lastName);

    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await nav("Projects").tap();
    await page
      .locator(".project-tile")
      .filter({ hasText: fixture.projects[0].name })
      .tap();
    await swipe(page.locator(".project-heading h2"));
    await expect(page.locator(".project-heading")).toHaveCount(0);
    await expect(page.locator(".project-tile")).not.toHaveCount(0);

    const conversation = fixture.conversations[0];
    await page.goto(`${fixture.base}/?conversation=${conversation.id}`, {
      waitUntil: "networkidle",
    });
    const draft = "Keep this draft when swiping back from the profile.";
    await dialog().getByLabel("Reply to agent", { exact: true }).fill(draft);
    await dialog().locator(".conversation-agent").tap();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    const teamLink = page.locator(".profile-team-link").first();
    const teamId = new URL(
      await teamLink.getAttribute("href"),
      fixture.base,
    ).searchParams.get("teams");
    await teamLink.tap();
    await expect(page.locator(".profile-head")).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get("teams"), teamId);
    await swipe(page.getByRole("heading", { name: "Feed", exact: true }));
    await expect(page.locator(".profile-head h1")).toBeVisible();
    await swipe(page.locator(".profile-team-link").first());
    await expect(page.locator(".conversation-sheet[open]")).toBeVisible();
    await expect(
      dialog().getByLabel("Reply to agent", { exact: true }),
    ).toHaveValue(draft);
    await swipe(dialog().getByLabel("Reply to agent", { exact: true }));
    await expect(
      dialog().getByLabel("Reply to agent", { exact: true }),
    ).toHaveValue(draft);
    await dialog()
      .getByRole("button", { name: "Add attachments", exact: true })
      .tap();
    await expect(page.locator("dialog[open]")).toHaveCount(2);
    await swipe(dialog().locator(".sheet-head h2"));
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(
      dialog().getByLabel("Reply to agent", { exact: true }),
    ).toHaveValue(draft);
    await capture("swipe-back-conversation-draft");
    await dialog().getByLabel("Reply to agent", { exact: true }).fill("");
    await swipe(dialog().locator(".messages .markdown p").first());
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);

    await page.goto(`${fixture.base}/?artifact=${fixture.artifacts[0]}`, {
      waitUntil: "networkidle",
    });
    const table = dialog().locator(".table-scroll").first();
    assert(
      await table.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
      "Fixture table must scroll horizontally",
    );
    await swipe(table);
    await expect(page.locator(".result-sheet[open]")).toBeVisible();
    if (client)
      assert(
        await table.evaluate((element) => element.scrollLeft > 0),
        "Table swipe must scroll its columns",
      );
    await swipe(dialog().locator(".markdown > p").first());
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    const root = page.url();
    await swipe(page.getByRole("heading", { name: "Feed", exact: true }));
    assert.equal(page.url(), root, "Swiping at the root must stay in Loop");
    console.log(
      `${engine}: left-swipe page/sheet back, draft/scroll restoration and gesture exclusions passed`,
    );
  } finally {
    await client?.detach();
  }
}
