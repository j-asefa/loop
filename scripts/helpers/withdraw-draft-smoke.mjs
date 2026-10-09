import { expect } from "@playwright/test";

// The server cancels real queued work before the delayed response arrives.
export async function withdrawDraftSmoke(page, fixture) {
  const run = fixture.db
    .prepare("SELECT * FROM runs WHERE state='queued' LIMIT 1")
    .get();
  const dialog = () => page.locator("dialog.conversation-sheet[open]");
  const reply = () => dialog().getByLabel("Reply to agent", { exact: true });
  let release;
  let arrived;
  const reached = new Promise((resolve) => {
    arrived = resolve;
  });
  await page.route("**/api/runs/*/withdraw", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => {
      release = resolve;
      arrived();
    });
    await route.fulfill({ response });
  });
  try {
    await page.goto(fixture.base + "/?conversation=" + run.conversation_id);
    await dialog()
      .getByRole("button", { name: "Move to draft", exact: true })
      .click();
    await reached;
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog()).toHaveCount(0);
    release();
    await expect
      .poll(() =>
        page.evaluate(
          (text) => Object.values(localStorage).some((value) => value === text),
          run.input,
        ),
      )
      .toBe(true);
    await page.goto(fixture.base + "/?conversation=" + run.conversation_id);
    await expect(reply()).toHaveValue(run.input);
    expect(
      fixture.db.prepare("SELECT state FROM runs WHERE id=?").get(run.id).state,
    ).toBe("cancelled");
  } finally {
    release?.();
  }
}
