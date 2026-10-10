import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function doneCardDismissalSmoke(page, fixture, engine) {
  const client =
    engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const swipe = async (row) => {
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    const x = Math.min(350, box.x + box.width - 30),
      y = box.y + Math.min(40, box.height / 2);
    if (client) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      for (let step = 1; step <= 8; step++) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x - (170 * step) / 8, y, id: 1 }],
        });
        await page.waitForTimeout(16);
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } else {
      // WebKit has no CDP touch injection; dispatch the card's pointer sequence.
      const pointer = {
        pointerType: "touch",
        pointerId: 1,
        clientX: x,
        clientY: y,
        bubbles: true,
      };
      await row.dispatchEvent("pointerdown", pointer);
      for (let step = 1; step <= 8; step++) {
        await row.dispatchEvent("pointermove", {
          ...pointer,
          clientX: x - (170 * step) / 8,
        });
        await page.waitForTimeout(16);
      }
      await row.dispatchEvent("pointerup", { ...pointer, clientX: x - 170 });
    }
    await page.waitForTimeout(300);
  };
  try {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    const row = page.locator(
      `.inbox-row[aria-label^="${fixture.conversations[0].title}"]`,
    );
    await expect(row).toHaveCount(1);
    await swipe(row);
    await expect(row).toHaveCount(0);
    await page.reload({ waitUntil: "networkidle" });
    await expect(row).toHaveCount(0);
    // Restore through the API to check the UI's Undo separately after reload.
    const cardKey = "run:" + fixture.conversations[0].run;
    await fixture.api(
      `/inbox/${fixture.conversations[0].id}`,
      { hidden: false, cardKey },
      "PATCH",
    );
    await page.reload({ waitUntil: "networkidle" });
    await swipe(row);
    const toast = page
      .getByRole("status")
      .filter({ hasText: "Removed from Done" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(row).toHaveCount(1);
    // A Done dismissal must not hide follow-up work or its eventual result.
    const target = fixture.conversations[0];
    const followUp = randomUUID();
    const started = Date.now();
    fixture.db
      .prepare(
        `
        INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,worker_id,created_at,updated_at)
        SELECT ?,owner_id,agent_id,conversation_id,'Follow-up stays visible','running',?,payload,'fixture',?,?
        FROM runs WHERE id=?
      `,
      )
      .run(followUp, followUp, started, started, target.run);
    await page.reload({ waitUntil: "networkidle" });
    const before = (await fixture.api("/inbox?filter=done")).summary;
    await swipe(row);
    await expect(row).toHaveCount(0);
    assert.deepEqual((await fixture.api("/inbox?filter=done")).summary, before);
    let dismissRequests = 0;
    const countDismiss = (request) => {
      if (
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === `/api/inbox/${target.id}`
      )
        dismissRequests++;
    };
    page.on("request", countDismiss);
    for (const [state, filter] of [
      ["running", "working"],
      ["queued", "queued"],
      ["paused", "done"],
    ]) {
      fixture.db
        .prepare("UPDATE runs SET state=? WHERE id=?")
        .run(state, followUp);
      await page.goto(`${fixture.base}/?filter=${filter}`, {
        waitUntil: "networkidle",
      });
      if (state === "paused") {
        const showAll = page.getByRole("region", { name: "Needs you", exact: true })
          .getByRole("button", { name: "Show all", exact: true });
        if (await showAll.isVisible()) await showAll.click();
      }
      const activeRow = page.locator('.inbox-row[aria-label^="Follow-up stays visible"]');
      await expect(activeRow).toHaveCount(1);
      await expect(
        activeRow.locator("xpath=../..").locator(".swipe-under"),
      ).toHaveCount(0);
      await swipe(activeRow);
      await expect(activeRow).toHaveCount(1);
    }
    page.off("request", countDismiss);
    assert.equal(dismissRequests, 0, "Only Done cards offer dismissal");
    fixture.db
      .prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?")
      .run(started + 1, followUp);
    fixture.db
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','The follow-up result is visible.',?)",
      )
      .run(randomUUID(), fixture.owner, target.id, followUp, started + 1);
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    const newResult = page.locator('.inbox-row[aria-label^="Follow-up stays visible"]');
    await expect(newResult).toHaveCount(1);
    await expect(newResult).toContainText("The follow-up result is visible.");
  } finally {
    await client?.detach();
  }
}
