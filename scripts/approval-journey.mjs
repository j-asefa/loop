import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function approvalJourney(page, api) {
  const review = page.getByRole("button", {
    name: "Review approval: Metrics",
    exact: true,
  });
  await expect(review).toBeVisible();
  const dialog = page.getByRole("dialog", {
    name: "Review approval",
    exact: true,
  });
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("fixture latency");
  await expect(dialog).toContainText("@journey-agent");
  await expect(
    dialog.getByText("Request details", { exact: true }),
  ).toBeVisible();
  assert.equal(await dialog.locator("details").getAttribute("open"), null);
  await dialog.getByRole("button", { name: "Open conversation" }).click();
  await expect(page.locator("dialog[open]").last()).toContainText(
    "Show latency",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await review.click();
  let attempts = 0;
  const count = (request) => {
    if (request.method() === "POST" && /\/api\/approvals\//.test(request.url()))
      attempts++;
  };
  page.on("request", count);
  await page.route(
    "**/api/approvals/*",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture approval connection failed" }),
      }),
    { times: 1 },
  );
  await dialog
    .getByRole("button", { name: "Approve and continue", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Fixture approval connection failed",
  );
  await expect(
    dialog.getByRole("button", { name: "Approve and continue", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Approve and continue", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(dialog).toBeHidden();
  assert.equal(
    attempts,
    2,
    "One failed attempt and one successful decision, even with a repeated click",
  );
  page.off("request", count);
  const agent = (await api("/bootstrap")).agents.find(
    (a) => a.name === "journey-agent",
  );
  // The following approval cases are independent tasks. Sending them while the
  // just-approved task is still running would correctly steer that task instead.
  await expect
    .poll(
      async () =>
        (await api("/runs")).find(
          (run) => run.agent_id === agent.id && run.input === "Show latency",
        )?.state,
      { timeout: 10000 },
    )
    .toBe("completed");
  async function request() {
    const run = await api("/runs", {
      agentId: agent.id,
      input: "approval-navigation-fixture",
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(run.steeringId, undefined, "Approval fixture needs a new run");
    await expect
      .poll(async () =>
        (await api("/approvals")).some((a) => a.run_id === run.id),
      )
      .toBe(true);
    await page
      .getByRole("button", {
        name: "Review approval: Open a webpage",
        exact: true,
      })
      .click();
    return run;
  }
  const rejected = await request();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await expect(
        dialog.getByRole("heading", { name: "Open a webpage" }),
      ).toBeVisible();
      await expect(dialog.locator(".approval-target")).toContainText(
        "https://example.com/search?q=Codex",
      );
      assert.equal(
        await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
        false,
      );
      const approve = dialog.getByRole("button", {
        name: "Approve and continue",
        exact: true,
      });
      await approve.scrollIntoViewIfNeeded();
      assert.ok((await approve.boundingBox()).height >= 44);
      await dialog.locator(".sheet-body").evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({
        path: join(tmpdir(), `loop-approval-${width}-${theme}.png`),
      });
    }
  }
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(
      async () => (await api("/runs")).find((r) => r.id === rejected.id)?.state,
    )
    .toBe("failed");
  const stale = await request();
  const pending = (await api("/approvals")).find((a) => a.run_id === stale.id);
  await api("/approvals/" + pending.id, { decision: "reject" });
  await expect(dialog).toContainText("Request no longer pending", {
    timeout: 10000,
  });
  await expect(
    dialog.getByRole("button", { name: "Approve and continue", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  console.log(
    "PASS: readable approval details, conversation context, 320/390 layouts in both themes, failed-decision retry, duplicate-click protection, approval/rejection and stale-request handling.",
  );
}

export async function chatDismissJourney(page, api) {
  const run = (await api("/runs")).find(
    (r) => r.input === "Explain bids precisely",
  );
  const url = new URL(page.url());
  url.search = "?conversation=" + run.conversation_id;
  // A spacious conversation now fits the short fixture answer without scrolling.
  // Supply a long answer so the gesture test still exercises scrolled history.
  const conversationRoute = `**/api/conversations/${run.conversation_id}`;
  await page.route(conversationRoute, async (route) => {
    const response = await route.fetch();
    const conversation = await response.json();
    conversation.messages = conversation.messages.map((message) =>
      message.role === "assistant"
        ? { ...message, content: (message.content + "\n\n").repeat(25) }
        : message,
    );
    await route.fulfill({ response, json: conversation });
  });
  const open = () => page.goto(url.href);
  await page.setViewportSize({ width: 390, height: 650 });
  await open();
  const dialog = page.locator("dialog.swipe-sheet");
  await expect(dialog.getByLabel("Reply to agent")).toBeVisible();
  await dialog
    .getByLabel("Reply to agent")
    .fill("Keep my draft when I pull down.");
  async function touch(target, dx, dy, end = "touchend") {
    return target.evaluate(
      (el, { dx, dy, end }) => {
        const box = el.getBoundingClientRect(),
          x = box.x + box.width / 2,
          y = box.y + 5;
        const event = (type, atX, atY) => {
          const e = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(e, "touches", {
            value:
              type === "touchend" || type === "touchcancel"
                ? []
                : [{ clientX: atX, clientY: atY }],
          });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        };
        event("touchstart", x, y);
        const prevented = event("touchmove", x + dx, y + dy);
        event(end, x + dx, y + dy);
        return prevented;
      },
      { dx, dy, end },
    );
  }
  // A pull in scrolled history or a text input must remain a scroll/edit gesture.
  await dialog.locator(".messages").evaluate((el) => (el.scrollTop = 80));
  assert.ok(
    await dialog.locator(".messages").evaluate((el) => el.scrollTop > 0),
  );
  assert.equal(await touch(dialog.locator(".message").first(), 0, 160), false);
  await expect(dialog).toBeVisible();
  await dialog.locator(".messages").evaluate((el) => (el.scrollTop = 0));
  assert.equal(await touch(dialog.getByLabel("Reply to agent"), 0, 160), false);
  assert.equal(await touch(dialog.locator(".sheet-head h2"), 140, 20), false);
  assert.equal(await touch(dialog.locator(".sheet-head h2"), 0, -140), false);
  assert.equal(
    await touch(dialog.locator(".sheet-grip"), 0, 90, "touchcancel"),
    true,
  );
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((el) => el.style.getPropertyValue("--sheet-drag-y")),
    )
    .toBe("");
  const grip = dialog.getByRole("button", {
    name: "Close conversation",
    exact: true,
  });
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 20, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((el) => el.style.getPropertyValue("--sheet-drag-y")),
    )
    .toBe("");
  await page.screenshot({
    path: join(tmpdir(), "loop-chat-drag-handle.png"),
  });
  if (process.env.LOOP_BROWSER !== "webkit") {
    const cdp = await page.context().newCDPSession(page);
    const heading = await grip.boundingBox();
    const x = heading.x + 30,
      y = heading.y + 10;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let distance = 20; distance <= 160; distance += 20)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + distance }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  } else await touch(grip, 0, 160);
  await expect(dialog).toBeHidden();
  await open();
  await expect(dialog.getByLabel("Reply to agent")).toHaveValue(
    "Keep my draft when I pull down.",
  );
  // The sticky handle also closes a chat from the middle of the history.
  await dialog.locator(".messages").evaluate((el) => (el.scrollTop = 80));
  const handle = await grip.boundingBox();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2 + 160,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.unroute(conversationRoute);
  console.log(
    "PASS: chat pull-down dismissal, visible sticky handle, cancelled/short/sideways/upward gestures, scroll and input isolation, and draft preservation.",
  );
}

export async function semanticStatusJourney(page) {
  let status = {
    enabled: true,
    state: "preparing",
    total: 20,
    indexed: 0,
    pending: 20,
    detail:
      "Preparing the local search model. Keyword search is available now.",
  };
  const route = (request) =>
    request.fulfill({
      contentType: "application/json",
      body: JSON.stringify(status),
    });
  await page.route("**/api/search/status", route);
  const nav = page.getByRole("navigation").last();
  try {
    // Index status moved from the Search page's options disclosure into
    // Settings → Search preferences; Search itself no longer shows it.
    await nav.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
    await expect(page.locator(".search-index-status")).toHaveCount(0);
    await openSettings(page);
    await page.getByRole("button", { name: /Search preferences/ }).click();
    const preferences = page.getByRole("dialog", {
      name: "Search preferences",
      exact: true,
    });
    const banner = preferences.locator(".search-index-status");
    await expect(banner).toContainText("0 of 20 items indexed");
    status = {
      ...status,
      state: "indexing",
      indexed: 12,
      pending: 8,
      detail: "Building the search index: 12 of 20 items ready.",
    };
    await expect(banner).toContainText("12 of 20 items indexed");
    status = {
      ...status,
      state: "error",
      detail:
        "Local semantic indexing failed. Loop will retry automatically; keyword search is available.",
    };
    await expect(banner).toContainText("Semantic search needs attention");
    await expect(banner).toContainText("keyword search is available");
    status = {
      ...status,
      state: "ready",
      indexed: 20,
      pending: 0,
      detail: "Semantic search is ready. 20 items indexed.",
    };
    await expect(banner).toContainText("Semantic search ready");
    await expect(banner).not.toContainText("waiting");
    await page.screenshot({
      path: join(tmpdir(), "loop-semantic-status.png"),
    });
    await closeSheets(page);
  } finally {
    await page.unroute("**/api/search/status", route);
    await nav.getByRole("button", { name: "Feed", exact: true }).click();
  }
  console.log(
    "PASS: semantic index preparation, live progress, actionable failure and recovery status in Search preferences (status fixtures).",
  );
}
