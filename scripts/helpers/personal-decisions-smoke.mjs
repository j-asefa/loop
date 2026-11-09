import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { closeSheets } from "./browser-ui.mjs";

export async function personalDecisionsSmoke(page, fixture, engine, capture) {
  const checkLayout = async (card, width) => {
    assert(
      await card.evaluate((node) => {
        const author = node
          .querySelector(".identity strong")
          .getBoundingClientRect();
        const content = node
          .querySelector(".card-content")
          .getBoundingClientRect();
        const action = node
          .querySelector(".preview-open")
          .getBoundingClientRect();
        return (
          Math.abs(author.left - content.left) <= 1 &&
          action.height >= 44 &&
          node.scrollWidth <= node.clientWidth
        );
      }),
      `History must align with its author and keep a touch-sized action at ${width}px`,
    );
  };
  const approval = (await fixture.api("/approvals"))[0];
  await fixture.api(`/approvals/${approval.id}`, { decision: "approve" });
  const run = fixture.db
    .prepare("SELECT * FROM runs WHERE id=?")
    .get(approval.run_id);
  const started = Date.now();
  const longQuestion =
    "Which environment should we deploy to while the canary rollout is running? Keep staging available until the review is complete.";
  const freeTextAnswer =
    "Keep staging available for review.\nRun the canary in parallel.";
  const seed = (
    index,
    state = "resolved",
    response = { environment: ["Staging", "Canary"], token: null },
    kind = "answer",
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
            JSON.stringify(
              kind === "approval"
                ? {
                    kind: "approval",
                    title: "Publish release notes",
                    detail:
                      "Publish the release notes before the canary review is complete.",
                    choices: ["allow", "deny"],
                  }
                : {
                    kind: "question",
                    title: `Shipping preferences ${index}`,
                    detail: "A long request " + "x".repeat(10_000),
                    questions: [
                      {
                        id: "environment",
                        title:
                          index === 51 ? longQuestion : "Which environment?",
                      },
                      { id: "token", title: "Access token", secret: true },
                    ],
                  },
            ),
            state,
            randomUUID(),
            started + index,
          );
        fixture.db
          .prepare(
            `INSERT INTO personal_decisions(id,owner_id,run_id,native_decision_id,kind,response,response_truncated,created_at)
        VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            "native:" + id,
            run.owner_id,
            run.id,
            id,
            kind,
            JSON.stringify(response),
            Number(index === 51 || index === 47),
            started + index,
          );
      })
      .immediate();
  };
  for (let i = 0; i < 52; i++)
    seed(
      i,
      i === 50 ? "unknown" : "resolved",
      i === 49
        ? { environment: [], token: null }
        : i === 48
          ? { environment: [freeTextAnswer], token: null }
          : i === 47
            ? { environment: null, token: null }
            : undefined,
    );
  seed(52, "resolved", { choice: "deny" }, "approval");
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
    const approvalCard = history
      .locator("article")
      .filter({ hasText: "Your choice: Approved" });
    const deniedCard = history
      .locator("article")
      .filter({ hasText: "Your choice: Deny" });
    await expect(deniedCard).toContainText("Publish release notes");
    await expect(
      deniedCard.locator(".personal-decision-outcome svg"),
    ).toHaveClass(/lucide-x/);
    await expect(
      approvalCard.getByRole("img", { name: / avatar$/ }),
    ).toBeVisible();
    await expect(approvalCard.locator("time")).toHaveAttribute("title", /\d/);
    const approvedColor = await approvalCard
      .locator(".personal-decision-outcome")
      .evaluate((node) => getComputedStyle(node).color);
    await expect(approvalCard.locator("details")).not.toHaveAttribute("open");
    const summary = approvalCard.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(approvalCard.locator("pre")).toContainText("pullNumber");
    await page.keyboard.press("Enter");
    await expect(approvalCard.locator("details")).not.toHaveAttribute("open");
    await checkLayout(approvalCard, width);
    await summary.evaluate((node) => node.blur());
    await history.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await capture(`personal-approvals-${width}`);
    // History reopens the saved request even after it left pending approvals.
    await approvalCard.getByRole("button", { name: /^Open approval:/ }).focus();
    await page.keyboard.press("Enter");
    const original = page.getByRole("dialog", {
      name: "Original approval",
      exact: true,
    });
    await expect(original.locator(".approval-target")).toHaveText(
      "sample/loop #42",
    );
    await expect(original.locator(".approval-arguments")).toContainText(
      "Two issues need attention before this change is ready.",
    );
    await expect(original).toContainText("Your choice: Approved");
    await expect(
      original.getByRole("button", { name: /Approve and continue|Reject/ }),
    ).toHaveCount(0);
    await capture(`original-approval-${width}`);
    await closeSheets(page);
    await expect(history.locator("article")).toHaveCount(2);
    // The card body and the keyboard-accessible title both open the request.
    await deniedCard.locator(".personal-decision-outcome").click();
    await expect(
      original.getByRole("heading", {
        name: "Publish release notes",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      original.getByRole("region", { name: "Request details" }),
    ).toContainText(
      "Publish the release notes before the canary review is complete.",
    );
    await expect(
      original.getByRole("group", { name: "Approval decision" }),
    ).toHaveCount(0);
    await closeSheets(page);
    await page.getByRole("tab", { name: "Answers", exact: true }).click();
    await expect(history.locator("article")).toHaveCount(50);
    const newest = history.locator("article").first();
    await expect(newest).toContainText("Shipping preferences 51");
    await expect(newest).toContainText(
      "Long responses are shortened in history.",
    );
    await expect(newest).toContainText("Secret response — not saved");
    await expect(newest.locator("dt").first()).toContainText(longQuestion);
    await expect(newest.locator("dd").first()).toContainText("You answered");
    await expect(newest.locator("dd").first().getByRole("listitem")).toHaveText(
      ["Staging", "Canary"],
    );
    await expect(newest.locator(".personal-decision-outcome")).toHaveText(
      "Answered",
    );
    await expect(newest.locator(".personal-decision-outcome")).toHaveCSS(
      "color",
      approvedColor,
    );
    await expect(newest.locator("dd").first()).toHaveCSS(
      "border-left-color",
      approvedColor,
    );
    const unconfirmed = history.locator("article").nth(1);
    await expect(
      unconfirmed.locator(".personal-decision-outcome"),
    ).not.toHaveCSS("color", approvedColor);
    await expect(unconfirmed.locator("dd").first()).toContainText(
      "Your response",
    );
    await expect(newest.locator("dd").nth(1)).not.toContainText("You answered");
    const unanswered = history.locator("article").nth(2).locator("dd").first();
    await expect(unanswered).toHaveText("No answer provided");
    const freeText = history.locator("article").nth(3).locator("dd").first();
    await expect(freeText).toContainText("You answered");
    await expect(freeText.locator("p")).toHaveText(freeTextAnswer);
    const omitted = history.locator("article").nth(4);
    await expect(omitted.locator("dd").first()).toHaveText(
      "Not included in this preview",
    );
    await expect(omitted).toContainText(
      "Long responses are shortened in history.",
    );
    await expect(history).toContainText("Delivery was not confirmed");
    await checkLayout(newest, width);
    await history.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await capture(`personal-answers-${width}`);
    if (width === 390) {
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "dark"),
      );
      await capture("personal-answers-dark");
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "light"),
      );
    }
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
    assert(
      await newest
        .locator("pre")
        .evaluate(
          (node) =>
            node.scrollWidth <= node.clientWidth &&
            node.scrollHeight > node.clientHeight,
        ),
      "Long request details must wrap and scroll inside their preview",
    );
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

  console.log(
    `${engine}: profile history, bounded pagination, immediate refresh, live metadata, conversation navigation and 320/390/1280px layout passed`,
  );
}
