import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { seedCheckout } from "./checkout-fixture.mjs";

export async function feedReadingSmoke(page, fixture, capture) {
  const done = fixture.conversations.find((item) => item.state === "completed");
  const working = fixture.conversations.find(
    (item) => item.state === "running",
  );
  const mailThread = randomUUID();
  const markdownTitle = `**Message from @nova** (*direct message*) · thread \`${mailThread}\` This comes`;
  done.title = `Message from @nova (direct message) · thread ${mailThread} This comes`;
  fixture.db
    .prepare("UPDATE runs SET input=? WHERE id=?")
    .run(markdownTitle, done.run);
  const expectMailHeading = async (heading) => {
    await expect(heading).toHaveText(done.title);
    await expect(heading.locator("strong")).toHaveText("Message from @nova");
    await expect(heading.locator("em")).toHaveText("direct message");
    await expect(heading.locator("code")).toHaveText(mailThread);
    await expect(heading.locator("p, div, h1, h2, h3, pre")).toHaveCount(0);
  };
  const observations = new Map();
  for (const item of [done, working]) {
    const path = `src/${item.state}.ts`;
    const files = [{ path, additions: 2, deletions: 1, binary: false }];
    const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-before\n+after\n+verified\n`;
    const summary = seedCheckout(fixture.db, item.run, { files, patch });
    observations.set(item.run, { files, patch, summary });
    if (item === working)
      fixture.db
        .prepare(
          "UPDATE run_checkouts SET state='started', files='[]', patch='', ended_at=NULL, summary=? WHERE run_id=?",
        )
        .run(
          JSON.stringify({
            ...summary,
            state: "started",
            files: 0,
            additions: 0,
            deletions: 0,
          }),
          item.run,
        );
  }
  const seedCheck = (item, command, kind, status, exit) => {
    fixture.db
      .prepare(
        `INSERT INTO run_verifications(
      id,owner_id,run_id,conversation_id,source_id,kind,tools,command,status,exit_code,output_tail,observed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        fixture.owner,
        item.run,
        item.id,
        randomUUID(),
        kind,
        JSON.stringify([command]),
        command,
        status,
        exit,
        `Fixture output: ${command}`,
        Date.now(),
      );
  };
  seedCheck(done, "npm test", "test", "passed", 0);
  seedCheck(done, "npm run typecheck", "typecheck", "failed", 1);
  seedCheck(done, "npm run lint", "lint", "unknown", null);
  seedCheck(working, "npm run typecheck", "typecheck", "passed", 0);
  const fullMessage =
    "A detailed result.\n\n" +
    "Further findings.\n\n".repeat(350) +
    "\n\nEnd of the full result. https://github.com/acme/api/pull/42";
  fixture.db
    .prepare(
      "UPDATE messages SET content=? WHERE run_id=? AND role='assistant'",
    )
    .run(fullMessage, done.run);
  const reader = page.locator("dialog.feed-reading-sheet[open]");
  const thread = page.locator("dialog.conversation-sheet[open]");
  const close = async (sheet) => {
    await sheet
      .locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  for (const [filter, state] of [
    ["done", "completed"],
    ["working", "running"],
    ["queued", "queued"],
  ]) {
    await page.setViewportSize({
      width: filter === "done" ? 390 : 320,
      height: 844,
    });
    const item = fixture.conversations.find((value) => value.state === state);
    await page.goto(`${fixture.base}/?filter=${filter}`, {
      waitUntil: "networkidle",
    });
    const card = page
      .locator(".inbox-results .inbox-card")
      .filter({ hasText: item.title });
    if (filter === "done") {
      await expectMailHeading(card.getByRole("heading", { level: 2 }));
      await expect(card.locator(".preview")).not.toContainText(
        "End of the full result.",
      );
    }
    await card.locator(".inbox-row").click();
    await expect(reader).toBeVisible();
    await expect(thread).toHaveCount(0);
    await expect(reader.locator(".result-identity")).toBeVisible();
    await expect(reader.locator(".result-title")).toHaveText(item.title);
    if (filter === "done")
      await expectMailHeading(reader.getByRole("heading", { level: 3 }));
    await expect
      .poll(() => reader.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    if (filter === "done") {
      await expect(reader.locator(".artifact-body")).toContainText(
        "End of the full result.",
      );
      await capture("feed-reading-heading");
    }
    await reader.locator(".result-content").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(
      reader.getByRole("button", { name: "Reply", exact: true }),
    ).toBeInViewport();
    await expect(
      reader.getByRole("group", { name: "Changes and checks" }),
    ).toHaveCount(0);
    await expect(
      reader.locator(".checkout-chip, .verification-chip"),
    ).toHaveCount(0);
    await expect(
      card.locator(".checkout-chip, .verification-chip, .pull-state-chip"),
    ).toHaveCount(0);
    if (filter === "done") {
      const pulls = reader.locator(".conversation-pulls");
      await expect(pulls.locator("summary")).toContainText("acme/api#42");
      await pulls.locator("summary").click();
      await expect(pulls.getByRole("link", { name: "GitHub" })).toHaveAttribute(
        "href",
        "https://github.com/acme/api/pull/42",
      );
      await expect(pulls).toContainText("Connect GitHub");
    }
    if (filter === "working") {
      const observed = observations.get(item.run);
      fixture.db
        .prepare(
          "UPDATE run_checkouts SET state='captured', files=?, patch=?, summary=?, ended_at=? WHERE run_id=?",
        )
        .run(
          JSON.stringify(observed.files),
          observed.patch,
          JSON.stringify(observed.summary),
          Date.now(),
          item.run,
        );
      seedCheck(item, "npm test", "test", "passed", 0);
      await page.evaluate(() =>
        window.dispatchEvent(new Event("loop-source-refresh")),
      );
      await expect(
        reader.locator(".checkout-chip, .verification-chip"),
      ).toHaveCount(0);
    }
    await capture(`feed-reading-${filter}`);
    await reader.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(reader).toHaveCount(0);
    await expect(thread).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(item.id);
    await expect(
      thread.getByRole("textbox", { name: "Reply to agent" }),
    ).toBeFocused();
    await close(thread);
    // Keyboard opening and closing returns to the same feed filter.
    await card.locator(".inbox-row").focus();
    await page.keyboard.press("Enter");
    await expect(reader).toBeVisible();
    await close(reader);
    await expect(card).toBeVisible();
  }
  await page.goto(`${fixture.base}/?filter=done`, { waitUntil: "networkidle" });
  await page.route("**/api/messages/*", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Fixture message unavailable" },
    }),
  );
  await page
    .locator(".inbox-results .inbox-row")
    .filter({ hasText: done.title })
    .click();
  // Cards already contains the full body; opening it needs no per-message read.
  await expect(reader.getByRole("alert")).toHaveCount(0);
  await expect(reader.locator(".artifact-body")).toContainText(
    "End of the full result.",
  );
  await reader.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread).toBeVisible();
  await expect(reader).toHaveCount(0);
  await close(thread);
  const draft = "An unsent follow-up.\n\n" + "Draft details. ".repeat(30);
  await page.evaluate(
    ({ owner, id, draft }) => {
      localStorage.setItem(`loop-draft-text:${owner}:${id}`, draft);
      localStorage.setItem(
        `loop-draft-text:another-owner:${id}`,
        "Private draft",
      );
    },
    { owner: fixture.owner, id: done.id, draft },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .locator(".inbox-results .inbox-row")
    .filter({ hasText: done.title })
    .click();
  const draftPreview = reader.getByRole("region", { name: "Draft message" });
  await expect(draftPreview).toContainText(draft.replace(/\s+/g, " "));
  await expect(reader).not.toContainText("Private draft");
  await capture("feed-reading-draft");
  await reader
    .getByRole("button", { name: "Continue draft", exact: true })
    .click();
  await expect(reader).toHaveCount(0);
  await expect(
    thread.getByRole("textbox", { name: "Reply to agent" }),
  ).toHaveValue(draft);
}
