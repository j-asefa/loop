import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { closeSheets } from "./browser-ui.mjs";

export async function personalDecisionsSmoke(page, fixture, engine, capture) {
  const approval = (await fixture.api("/approvals"))[0];
  await fixture.api(`/approvals/${approval.id}`, { decision: "approve" });
  const run = fixture.db
    .prepare("SELECT * FROM runs WHERE id=?")
    .get(approval.run_id);
  const started = Date.now();
  const seed = (
    index,
    state = "resolved",
    response = { environment: ["Staging", "Canary"], token: null },
  ) => {
    const id = randomUUID();
    fixture.db
      .transaction(() => {
        fixture.db
          .prepare(
            `INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,state,command_id,created_at)
        VALUES(?,?,?,'fixture',?,?,?,?,?)`,
          )
          .run(
            id,
            run.id,
            run.conversation_id,
            id,
            JSON.stringify({
              kind: "question",
              title: `Shipping preferences ${index}`,
              detail: "A long request " + "x".repeat(10_000),
              questions: [
                { id: "environment", title: "Which environment?" },
                { id: "token", title: "Access token", secret: true },
              ],
            }),
            state,
            randomUUID(),
            started + index,
          );
        fixture.db
          .prepare(
            `INSERT INTO personal_decisions(id,owner_id,run_id,native_decision_id,kind,response,response_truncated,created_at)
        VALUES(?,?,?,?,'answer',?,?,?)`,
          )
          .run(
            "native:" + id,
            run.owner_id,
            run.id,
            id,
            response && JSON.stringify(response),
            Number(index === 51),
            started + index,
          );
      })
      .immediate();
  };
  for (let i = 0; i < 52; i++)
    seed(i, i === 50 ? "unknown" : "resolved", i === 49 ? null : undefined);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(fixture.base + "/?page=profile&profileTab=approvals");
    await expect(
      page.getByRole("tab", { name: "Approvals", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const history = page.locator(".personal-decisions");
    await expect(
      history.getByText("Your choice: Approved", { exact: true }),
    ).toBeVisible();
    await history.getByText("Request details", { exact: true }).click();
    await expect(history.locator("pre")).toContainText("pullNumber");
    await page.getByRole("tab", { name: "Answers", exact: true }).click();
    await expect(history.locator("article")).toHaveCount(50);
    const newest = history.locator("article").first();
    await expect(newest).toContainText("Shipping preferences 51");
    await expect(newest).toContainText("Staging, Canary");
    await expect(newest).toContainText(
      "Long responses are shortened in history.",
    );
    await expect(newest).toContainText("Secret response — not saved");
    await expect(history).toContainText("Delivery was not confirmed");
    await expect(history).toContainText(
      "The response text was not saved for this older request.",
    );
    await newest.getByText("Request details", { exact: true }).click();
    await expect(newest).toContainText(
      "Long request details are shortened in history",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "History must fit the viewport",
    );
    await capture(`personal-answers-${width}`);
    await history
      .getByRole("button", { name: "Load more answers", exact: true })
      .click();
    await expect(history.locator("article")).toHaveCount(52);
    await newest
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    await expect(page.locator("dialog[open] .message").first()).toBeVisible();
    assert.equal(
      new URL(page.url()).searchParams.get("conversation"),
      run.conversation_id,
    );
    await closeSheets(page);
    await expect(history.locator("article")).toHaveCount(52);
    await page.reload();
    await expect(
      page.getByRole("tab", { name: "Answers", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(history.locator("article")).toHaveCount(50);
  }
  await page
    .locator(".personal-decisions")
    .getByRole("button", { name: "Load more answers", exact: true })
    .click();
  await expect(page.locator(".personal-decisions article")).toHaveCount(52);
  seed(52);
  await expect(page.locator(".personal-decisions article")).toHaveCount(53, {
    timeout: 12000,
  });
  await expect(
    page.locator(".personal-decisions article").first(),
  ).toContainText("Shipping preferences 52");

  // A change committed while an older HTTP snapshot is in flight must queue
  // another read; rendering that snapshot cannot swallow the notification.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let snapshotRead;
  const read = new Promise((resolve) => {
    snapshotRead = resolve;
  });
  let hold = true;
  await page.route("**/api/me/decisions?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (hold && params.get("kind") === "answer" && !params.has("before")) {
      hold = false;
      const response = await route.fetch();
      snapshotRead();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await read;
  seed(53);
  // An explicit refresh during a read must run as soon as that read finishes.
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  release();
  await expect(page.locator(".personal-decisions article")).toHaveCount(54, {
    timeout: 2500,
  });
  await page.unroute("**/api/me/decisions?**");

  fixture.db
    .prepare(
      "UPDATE conversations SET title='Updated release discussion' WHERE id=?",
    )
    .run(run.conversation_id);
  // Pull-to-refresh must advance an already scheduled, throttled invalidation.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("loop-workspace-change"));
    window.dispatchEvent(new Event("loop-refresh"));
  });
  await expect(
    page.locator(".personal-decisions article").first(),
  ).toContainText("Updated release discussion", { timeout: 2500 });
  // Losing the oldest loaded row must not drain all the older, unloaded pages.
  fixture.db
    .transaction(() => {
      const oldest = fixture.db
        .prepare(
          "SELECT native_decision_id FROM personal_decisions WHERE owner_id=? AND kind='answer' AND created_at=?",
        )
        .get(run.owner_id, started);
      fixture.db
        .prepare("DELETE FROM native_decisions WHERE id=?")
        .run(oldest.native_decision_id);
      for (let index = -1; index >= -150; index--) seed(index);
    })
    .immediate();
  await expect(page.locator(".personal-decisions article")).toHaveCount(53, {
    timeout: 12000,
  });
  await expect(
    page.getByRole("button", { name: "Load more answers", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Load more answers", exact: true })
    .click();
  await expect(page.locator(".personal-decisions article")).toHaveCount(103);
  await expect(page.locator(".personal-decisions")).toContainText(
    "Shipping preferences -1",
  );
  await expect(
    page.locator(".personal-decisions article").last(),
  ).toContainText("Shipping preferences -50");

  // Refreshing a full first page may prepend new decisions, but must never
  // reveal an extra page of older records without the user's Load more action.
  await page.reload();
  await expect(page.locator(".personal-decisions article")).toHaveCount(50);
  for (const index of [54, 55, 56]) {
    seed(index);
    await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
    await expect(page.locator(".personal-decisions article")).toHaveCount(
      index - 3,
      { timeout: 12000 },
    );
  }
  await expect(
    page.getByRole("button", { name: "Load more answers", exact: true }),
  ).toBeVisible();

  // Older sources omit the capability. Their profile stays usable and never
  // asks them for the endpoint they do not implement.
  // Stop the supported page's pending refreshes before observing the new page.
  await page.goto("about:blank");
  await page.route("**/api/capabilities", async (route) => {
    const response = await route.fetch();
    const capabilities = await response.json();
    delete capabilities.personalDecisions;
    await route.fulfill({ response, json: capabilities });
  });
  let historyReads = 0;
  const countHistory = (request) => {
    if (new URL(request.url()).pathname.endsWith("/me/decisions"))
      historyReads++;
  };
  page.on("request", countHistory);
  await page.goto(fixture.base + "/?page=profile&profileTab=answers");
  await expect(page.getByLabel("Decision history unavailable")).toContainText(
    "Update Loop",
  );
  await page.getByRole("tab", { name: "Approvals", exact: true }).click();
  await expect(page.getByLabel("Decision history unavailable")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    historyReads,
    0,
    "Unsupported sources must not receive history requests",
  );
  page.off("request", countHistory);
  await page.unroute("**/api/capabilities");
  console.log(
    `${engine}: profile history, bounded pagination, immediate refresh, older-source fallback, live metadata, conversation navigation and 320/390/1280px layout passed`,
  );
}
