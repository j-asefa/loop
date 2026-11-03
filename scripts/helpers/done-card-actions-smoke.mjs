import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function doneCardActionsSmoke(page, fixture, engine, capture) {
  const done = fixture.conversations
    .filter((item) => item.state === "completed")
    .slice(0, 2);
  assert.equal(done.length, 2);
  const third = {
    id: randomUUID(),
    run: randomUUID(),
    title: "Third result",
    state: "completed",
  };
  fixture.db
    .prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) SELECT ?,owner_id,agent_id,?,created_at FROM conversations WHERE id=?",
    )
    .run(third.id, third.title, done[0].id);
  fixture.db
    .prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) SELECT ?,owner_id,agent_id,?,?,'completed',?,created_at,updated_at FROM runs WHERE id=?",
    )
    .run(third.run, third.id, third.title, third.run, done[0].run);
  fixture.db
    .prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) SELECT ?,owner_id,?,?,'assistant','Third result','{}',created_at FROM messages WHERE run_id=? AND role='assistant' LIMIT 1",
    )
    .run(randomUUID(), third.id, third.run, done[0].run);
  done.push(third);
  const at = Date.now() + 2000;
  const texts = done.map(
    (_, index) =>
      `Result ${index + 1}.\n\n${"Full findings beyond the feed preview. ".repeat(90)}\n\nEND OF RESULT ${index + 1}`,
  );
  for (const [index, item] of done.entries()) {
    item.title = `Aggregation result ${index + 1}`;
    fixture.db
      .prepare("UPDATE runs SET input=?,updated_at=? WHERE id=?")
      .run(item.title, at - index, item.run);
    fixture.db
      .prepare(
        "UPDATE messages SET content=?,created_at=? WHERE run_id=? AND role='assistant'",
      )
      .run(texts[index], at - index, item.run);
  }
  const original = () =>
    ["messages", "runs"].map((table) =>
      fixture.db.prepare("SELECT * FROM " + table + " ORDER BY id").all(),
    );
  const before = original();
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  await page.locator("#composer").fill("Keep my existing draft.");
  await page.getByRole("button", { name: "Collapse composer" }).click();
  const card = (index) =>
    page.locator(".inbox-results [data-done-card]").filter({
      has: page.getByRole("heading", {
        name: done[index].title,
        exact: true,
      }),
    });
  const menu = page.locator("dialog.action-sheet[open]");
  const aggregation = page.getByRole("dialog", {
    name: "Move cards to a thread",
    exact: true,
  });
  const close = async (sheet = menu) => {
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const client =
    engine === "chromium" ? await page.context().newCDPSession(page) : null;
  let start;
  const begin = async () => {
    await card(0).evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    const box = await card(0).locator("h2").boundingBox();
    start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (client)
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...start, id: 1 }],
      });
    else
      await card(0).dispatchEvent("pointerdown", {
        pointerType: "touch",
        bubbles: true,
        pointerId: 41,
        isPrimary: true,
        button: 0,
        clientX: start.x,
        clientY: start.y,
      });
    await expect(page.locator(".card-drag-hint")).toBeVisible();
  };
  const move = async (point) => {
    if (client)
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, id: 1 }],
      });
    else
      await card(0).dispatchEvent("pointermove", {
        pointerType: "touch",
        bubbles: true,
        pointerId: 41,
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
      });
  };
  const end = async (point = start, cancel = false) => {
    if (client)
      await client.send("Input.dispatchTouchEvent", {
        type: cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    else
      await card(0).dispatchEvent(cancel ? "pointercancel" : "pointerup", {
        pointerType: "touch",
        bubbles: true,
        pointerId: 41,
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
      });
  };
  let sends = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(runs|conversations\/.*\/continuation)/.test(
        new URL(request.url()).pathname,
      )
    )
      sends++;
  });
  try {
    // Real touch in Chromium; WebKit exercises the same production pointer handlers.
    await begin();
    await end();
    await expect(menu).toBeVisible();
    for (const label of [
      "Reply",
      "Save",
      "Remind me",
      "Mark unread",
      "Select cards",
      "Move to…",
      "Combine with another card",
      "Remove from Done",
    ])
      await expect(
        menu.getByRole("menuitem", {
          name: label,
          exact: label !== "Save" && label !== "Combine with another card",
        }),
      ).toBeVisible();
    await expect(page.locator(".feed-reading-sheet")).toHaveCount(0);
    await capture("done-card-actions");
    // Save and dismissal target the held card, with the existing Undo behavior.
    await menu.getByRole("menuitem", { name: /^Save/ }).click();
    await card(0).getByRole("button", { name: "Thread actions" }).click();
    await expect(
      menu.getByRole("menuitem", { name: "Remove from Saved", exact: true }),
    ).toBeVisible();
    await menu
      .getByRole("menuitem", { name: "Remove from Done", exact: true })
      .click();
    await expect(card(0)).toHaveCount(0);
    await page
      .getByRole("status")
      .filter({ hasText: "Removed from Done" })
      .getByRole("button", { name: "Undo" })
      .click();
    await expect(card(0)).toHaveCount(1);

    // Cancelled and self drops leave both cards in place and open no reader.
    await begin();
    await move({ x: start.x + 20, y: start.y });
    await end({ x: start.x + 20, y: start.y });
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".feed-reading-sheet")).toHaveCount(0);
    await begin();
    await end(start, true);
    await expect(
      page.locator(".card-drag-hint, .card-drop-target"),
    ).toHaveCount(0);
    await expect(menu).toHaveCount(0);

    // Hold-and-drag has a visible target and presents choices before doing work.
    await begin();
    const targetBox = await card(1).locator("h2").boundingBox();
    const target = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };
    assert.ok(
      target.y < 1000,
      "Both fixture cards should be visible for the touch drop",
    );
    await move(target);
    await expect(card(1)).toHaveClass(/card-drop-target/);
    await end(target);
    await expect(aggregation).toBeVisible();
    await expect(aggregation).toContainText("2 cards selected");
    await expect(
      aggregation.getByRole("menuitem", { name: /^Combine into a new thread/ }),
    ).toBeEnabled();
    await capture("card-grouping-options");
    await close();
    await expect(card(0)).toHaveCount(1);
    await expect(card(1)).toHaveCount(1);

    // A foreign drag payload is not a selection from this Feed.
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await transfer.evaluate(
      (data, key) => data.setData("application/x-loop-done-card", key),
      await card(0).getAttribute("data-done-card"),
    );
    await card(1).dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await expect(aggregation).toHaveCount(0);

    await card(0).locator(".inbox-row").press("Shift+F10");
    await menu
      .getByRole("menuitem", { name: /^Combine with another card/ })
      .click();
    await page
      .getByRole("dialog", { name: "Choose another card" })
      .getByRole("menuitem", { name: new RegExp(done[1].title) })
      .click();
    await expect(aggregation).toContainText("2 cards selected");
    await close();

    // Mouse dragging presents the same choices. A failed write remains retryable.
    await card(0).locator("h2").dragTo(card(1).locator("h2"));
    await expect(aggregation).toBeVisible();
    await aggregation.getByLabel("New thread name").fill("Basil and Willow");
    const failingWrite = (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Thread temporarily unavailable" }),
          })
        : route.continue();
    await page.route("**/api/feed/threads", failingWrite);
    await aggregation
      .getByRole("menuitem", { name: /^Combine into a new thread/ })
      .click();
    await expect(aggregation.getByRole("alert")).toBeVisible();
    await expect(
      aggregation.getByRole("menuitem", { name: /^Combine into a new thread/ }),
    ).toBeEnabled();
    await page.unroute("**/api/feed/threads", failingWrite);
    await aggregation
      .getByRole("menuitem", { name: /^Combine into a new thread/ })
      .click();
    await expect(aggregation).toHaveCount(0);
    const grouped = page.locator(".inbox-results .inbox-card").filter({
      has: page.getByRole("heading", {
        name: "Basil and Willow",
        exact: true,
      }),
    });
    await expect(grouped).toHaveCount(1);
    await expect(grouped).toContainText("Thread · 2 cards");
    await expect(card(0)).toHaveCount(0);
    await expect(card(1)).toHaveCount(0);
    await page.reload({ waitUntil: "networkidle" });
    await expect(grouped).toHaveCount(1);
    const reader = page.locator("dialog.done-thread-sheet[open]");
    await grouped
      .getByRole("button", { name: "Open thread", exact: true })
      .click();
    await expect(reader.locator(".done-thread-message")).toHaveCount(2);
    await expect(reader.locator(".done-thread-message h3")).toHaveText([
      done[1].title,
      done[0].title,
    ]);
    for (let index = 0; index < 2; index++)
      await expect(reader).toContainText("END OF RESULT " + (index + 1));
    await expect(
      reader.getByRole("button", { name: "Open original conversation" }),
    ).toHaveCount(2);
    await close(reader);

    // The same saved thread is available in Threads after a reload, with the
    // complete reader and group menu. Its original conversations stay available.
    const filters = page.getByRole("tablist", { name: "Show", exact: true });
    const threadsTab = filters.getByRole("tab", {
      name: "Threads",
      exact: true,
    });
    const doneTab = filters.getByRole("tab", { name: /^Done/ });
    await threadsTab.click();
    await expect(grouped).toHaveCount(1);
    await page.reload({ waitUntil: "networkidle" });
    await expect(threadsTab).toHaveAttribute("aria-selected", "true");
    await expect(grouped).toContainText("Thread · 2 cards");
    await grouped
      .getByRole("button", { name: "Open thread", exact: true })
      .click();
    await expect(reader.locator(".done-thread-message")).toHaveCount(2);
    await expect(reader).toContainText("END OF RESULT 1");
    await expect(reader).toContainText("END OF RESULT 2");
    await close(reader);
    await capture("combined-thread-in-threads");

    // Ungrouping in Threads removes the saved group and restores Done cards.
    await grouped.getByRole("button", { name: "Thread actions" }).click();
    await menu.getByRole("menuitem", { name: /^Ungroup cards/ }).click();
    await expect(grouped).toHaveCount(0);
    await doneTab.click();
    await expect(card(0)).toHaveCount(1);
    await expect(card(1)).toHaveCount(1);
    await card(0).locator(".inbox-row").press("Shift+F10");
    await menu
      .getByRole("menuitem", { name: "Select cards", exact: true })
      .click();
    const selection = page.getByRole("region", { name: "Selected cards" });
    await expect(selection).toContainText("1 selected");
    await card(1).getByRole("checkbox").check();
    await expect(selection).toContainText("2 selected");
    // Bulk read choices affect both selected results and survive a reload.
    const selectPair = async () => {
      await card(0).locator(".inbox-row").press("Shift+F10");
      await menu
        .getByRole("menuitem", { name: "Select cards", exact: true })
        .click();
      await card(1).getByRole("checkbox").check();
    };
    await selection
      .getByRole("button", { name: "Mark unread", exact: true })
      .click();
    await expect(selection).toHaveCount(0);
    for (const index of [0, 1])
      await expect(
        card(index).getByText("Unread", { exact: true }),
      ).toBeVisible();
    await selectPair();
    await selection
      .getByRole("button", { name: "Mark read", exact: true })
      .click();
    await expect(selection).toHaveCount(0);
    await page.reload({ waitUntil: "networkidle" });
    for (const index of [0, 1])
      await expect(
        card(index).getByText("Unread", { exact: true }),
      ).toHaveCount(0);
    await selectPair();
    await selection
      .getByRole("button", { name: "Move to…", exact: true })
      .click();
    await aggregation.getByLabel("New thread name").fill("Basil and Willow");
    await aggregation
      .getByRole("menuitem", { name: /^Combine into a new thread/ })
      .click();
    await expect(grouped).toContainText("Thread · 2 cards");
    await expect(selection).toHaveCount(0);

    // A single card can move to an existing thread without making another agent run.
    await card(2).getByRole("button", { name: "Thread actions" }).click();
    await menu.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await expect(
      aggregation.getByRole("menuitem", { name: /^Combine into a new thread/ }),
    ).toBeDisabled();
    await close();
    await card(2).locator("h2").dragTo(grouped.locator("h2"));
    await expect(aggregation).toContainText("3 cards selected");
    await aggregation
      .getByRole("menuitem", { name: /^Move to “Basil and Willow”/ })
      .click();
    await expect(grouped).toContainText("Thread · 3 cards");
    await expect(card(2)).toHaveCount(0);
    await grouped
      .getByRole("button", { name: "Open thread", exact: true })
      .click();
    await expect(reader.locator(".done-thread-message h3")).toHaveText([
      done[2].title,
      done[1].title,
      done[0].title,
    ]);
    for (const text of texts)
      assert.ok(
        (await reader.innerText())
          .replace(/\s+/g, " ")
          .includes(text.replace(/\s+/g, " ").trim()),
        "The thread retains the full original results",
      );
    await capture("done-thread-reading");
    await reader
      .getByRole("button", { name: "Remove from thread", exact: true })
      .first()
      .click();
    await expect(reader.locator(".done-thread-message")).toHaveCount(2);
    await close(reader);
    await expect(card(2)).toHaveCount(1);
    await expect(grouped).toContainText("Thread · 2 cards");
    await capture("done-thread-feed");
    // A quick horizontal swipe still dismisses only the ungrouped card.
    await card(2).scrollIntoViewIfNeeded();
    const swipeBox = await card(2).locator("h2").boundingBox();
    const swipeAt = {
      x: swipeBox.x + swipeBox.width - 10,
      y: swipeBox.y + swipeBox.height / 2,
    };
    if (client) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...swipeAt, id: 1 }],
      });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: swipeAt.x - 115, y: swipeAt.y, id: 1 }],
      });
    } else {
      await card(2).dispatchEvent("pointerdown", {
        pointerType: "touch",
        pointerId: 41,
        isPrimary: true,
        button: 0,
        bubbles: true,
        clientX: swipeAt.x,
        clientY: swipeAt.y,
      });
      await card(2).dispatchEvent("pointermove", {
        pointerType: "touch",
        pointerId: 41,
        isPrimary: true,
        bubbles: true,
        clientX: swipeAt.x - 115,
        clientY: swipeAt.y,
      });
    }
    await expect(card(2).locator("..")).toHaveClass(/armed-left/);
    if (client)
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    else
      await card(2).dispatchEvent("pointerup", {
        pointerType: "touch",
        pointerId: 41,
        isPrimary: true,
        bubbles: true,
        clientX: swipeAt.x - 115,
        clientY: swipeAt.y,
      });
    await expect(card(2)).toHaveCount(0);
    await expect(grouped).toContainText("Thread · 2 cards");
    await page
      .getByRole("status")
      .filter({ hasText: "Removed from Done" })
      .getByRole("button", { name: "Undo" })
      .click();
    await expect(card(2)).toHaveCount(1);
    await expect(page.locator("#composer")).toHaveValue(
      "Keep my existing draft.",
    );
    assert.equal(sends, 0, "Organizing cards never submits work to agents");
    assert.deepEqual(
      original(),
      before,
      "Grouping preserves stored messages and runs",
    );

    // New work in an original conversation does not replace the group's preview.
    const followUp = randomUUID();
    fixture.db
      .prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) SELECT ?,owner_id,agent_id,conversation_id,'A later separate result','completed',?,?,? FROM runs WHERE id=?",
      )
      .run(followUp, followUp, at + 1000, at + 1000, done[0].run);
    fixture.db
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Later work stays separate',?)",
      )
      .run(randomUUID(), fixture.owner, done[0].id, followUp, at + 1000);
    await threadsTab.click();
    await expect(grouped).toHaveCount(1);
    await expect(grouped).toContainText("Result 1.");
    await expect(grouped).not.toContainText("Later work stays separate");
    await expect(
      page.locator(".inbox-results .inbox-card").filter({
        has: page.getByRole("heading", {
          name: "A later separate result",
          exact: true,
        }),
      }),
    ).toHaveCount(1);

    // Groups also survive when their conversations fall outside the loaded page.
    const insertConversation = fixture.db.prepare(
      "INSERT INTO conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)",
    );
    const insertAnswer = fixture.db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'assistant','More recent work',?)",
    );
    fixture.db.transaction(() => {
      for (let index = 0; index < 45; index++) {
        const conversation = randomUUID(),
          time = at + 2000 + index;
        insertConversation.run(
          conversation,
          fixture.owner,
          `Recent thread ${index}`,
          time,
        );
        insertAnswer.run(randomUUID(), fixture.owner, conversation, time);
      }
    })();
    await page.reload({ waitUntil: "networkidle" });
    await expect(grouped).toHaveCount(1);
    await expect(page.locator(".inbox-results .inbox-card")).toHaveCount(41);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Load more", exact: true }),
    ).toHaveCount(0);
    await expect(grouped).toHaveCount(1);
    await grouped
      .getByRole("button", { name: "Open thread", exact: true })
      .click();
    await expect(reader.locator(".done-thread-message")).toHaveCount(2);
    await expect(reader).not.toContainText("Later work stays separate");
    await close(reader);

    // Another device's mutations update the open reader through production
    // workspace events, including additions, removals and deleting the group.
    await doneTab.click();
    const savedGroup = (await fixture.api("/feed/threads")).find(
      (thread) => thread.title === "Basil and Willow",
    );
    assert.ok(savedGroup);
    await grouped
      .getByRole("button", { name: "Open thread", exact: true })
      .click();
    await expect(reader.locator(".done-thread-message")).toHaveCount(2);
    await fixture.api(`/feed/threads/${savedGroup.id}/cards`, {
      cardIds: ["d:run:" + done[2].run],
    });
    await expect(reader.locator(".done-thread-message")).toHaveCount(3);
    await expect(reader).toContainText("END OF RESULT 3");
    await fixture.api(
      `/feed/threads/${savedGroup.id}/cards/${encodeURIComponent("d:run:" + done[2].run)}`,
      undefined,
      "DELETE",
    );
    await expect(reader.locator(".done-thread-message")).toHaveCount(2);
    await expect(reader).not.toContainText("END OF RESULT 3");

    // Valid dismissals from a stale client do not hide a saved group or its
    // full contents, even when every individual member has been dismissed.
    for (const item of done.slice(0, 2))
      await fixture.api(
        `/feed/${item.id}`,
        { hidden: true, cardKey: "run:" + item.run },
        "PATCH",
      );
    await expect(reader.locator(".done-thread-message")).toHaveCount(2);
    await close(reader);
    await page.reload({ waitUntil: "networkidle" });
    await expect(grouped).toContainText("Thread · 2 cards");
    await grouped
      .getByRole("button", { name: "Open thread", exact: true })
      .click();
    await expect(reader).toContainText("END OF RESULT 1");
    await expect(reader).toContainText("END OF RESULT 2");
    await fixture.api(`/feed/threads/${savedGroup.id}`, undefined, "DELETE");
    await expect(reader).toHaveCount(0);
    await expect(grouped).toHaveCount(0);
    assert.equal(
      fixture.db
        .prepare("SELECT count(*) n FROM done_thread_members WHERE thread_id=?")
        .get(savedGroup.id).n,
      0,
    );
  } finally {
    await client?.detach();
  }
}
