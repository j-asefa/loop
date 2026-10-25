import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { runReceipt } from "./run-receipt.mjs";

// Core Feed journeys: open a thread, reply in place, save a message into
// Later, jump through the outline and set a thread reminder.
export async function inboxFlowsSmoke(page, fixture, capture) {
  const dialog = () => page.locator("dialog[open]").last();
  const thread = () => page.locator("dialog.conversation-sheet[open]");
  const nav = (name) =>
    page.locator(".mobile-nav").getByRole("button", { name, exact: true });
  const row = (title) => page.locator(`.inbox-row[aria-label^="${title}"]`);
  const settled = async () => {
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const closeThread = async () => {
    await thread()
      .locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await settled();
  };
  const later = page.getByRole("region", { name: "Later", exact: true });
  // Confirmations sit over the page for a few seconds, like any snackbar.
  const dismissToast = async () => {
    const toast = page.locator(".action-toast");
    if (await toast.count())
      await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(toast).toHaveCount(0);
  };
  // Later's sections are tabs on your profile.
  const laterTab = (name) =>
    page
      .getByRole("region", { name: "Your profile", exact: true })
      .getByRole("tablist", { name: "Show" })
      .getByRole("tab", { name: new RegExp("^" + name) });
  const target = fixture.conversations[1];
  const agent = fixture.db
    .prepare(
      "SELECT a.name FROM agents a JOIN conversations c ON c.agent_id=a.id WHERE c.id=?",
    )
    .get(target.id);
  // A finished result stays in Done when its thread gets a reminder.
  const snoozed = fixture.conversations[0];
  // Three more prompts with long answers give the outline somewhere to jump.
  const start = fixture.db
    .prepare("SELECT max(created_at) at FROM messages WHERE conversation_id=?")
    .get(target.id).at;
  const insert = fixture.db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  const findings = Array.from(
    { length: 8 },
    (_, i) =>
      `Finding ${i + 1}: this option keeps the workflow simple and reviewable.`,
  ).join("\n\n");
  const prompts = [],
    answers = [];
  for (let i = 1; i <= 3; i++) {
    prompts.push(randomUUID());
    answers.push(randomUUID());
    insert.run(
      prompts.at(-1),
      fixture.owner,
      target.id,
      target.run,
      "user",
      `Outline prompt ${i}: compare option ${i} in detail.`,
      start + i * 10,
    );
    insert.run(
      answers.at(-1),
      fixture.owner,
      target.id,
      target.run,
      "assistant",
      findings,
      start + i * 10 + 1,
    );
  }
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.base, { waitUntil: "networkidle" });

    // Feed rows open a reading card; Reply opens the conversation.
    await row(target.title).click();
    const reading = page.locator("dialog.feed-reading-sheet[open]");
    await expect(reading).toHaveAttribute("aria-label", target.title);
    await expect(reading.locator(".artifact-body")).toContainText(findings);
    await capture("inbox-reading-card");
    await reading.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread()).toHaveAttribute("aria-label", target.title);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("conversation"))
      .toBe(target.id);
    await capture("inbox-open-thread");
    await closeThread();
    await row(target.title).focus();
    await page.keyboard.press("Enter");
    await expect(reading).toBeVisible();
    await reading.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread()).toHaveAttribute("aria-label", target.title);

    // "Jump to…" lists every prompt and scrolls the thread to the chosen one.
    const messages = thread().locator(".messages");
    const firstPrompt = thread().locator(`[id="message-${prompts[0]}"]`);
    await messages.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(firstPrompt).not.toBeInViewport();
    await thread()
      .getByRole("button", { name: "Jump to…", exact: true })
      .click();
    await expect(dialog()).toHaveAttribute("aria-label", "Jump to…");
    await dialog()
      .getByRole("button", { name: "Your prompts", exact: true })
      .click();
    const outline = dialog().locator(".outline-list li");
    await expect(outline).toHaveCount(4);
    await expect(outline.first()).toContainText(target.title);
    for (let i = 1; i <= 3; i++)
      await expect(outline.nth(i)).toContainText(`Outline prompt ${i}`);
    await capture("thread-outline");
    await outline.nth(1).getByRole("button").click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(firstPrompt).toBeInViewport();

    // Replying to a message keeps the thread open with a reply chip; sending
    // keeps the thread open and returns the composer to the thread itself.
    const answer = thread().locator(`[id="message-${answers[0]}"]`);
    const composer = thread().locator(".composer");
    const input = composer.getByRole("textbox", { name: "Reply to agent" });
    await answer.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(composer.locator(".composer-reply-chip")).toContainText(
      `Replying to @${agent.name}`,
    );
    await capture("thread-reply-chip");
    const requests = [];
    const accept = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: runReceipt(route.request(), "inbox-flow-reply") });
    };
    await page.route("**/api/runs", accept);
    try {
      await input.fill("Expand on finding 3.");
      await composer
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      await expect(input).toHaveValue("");
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await expect(thread()).toHaveAttribute("aria-label", target.title);
      await expect(composer.locator(".composer-reply-chip")).toHaveCount(0);
    } finally {
      await page.unroute("**/api/runs", accept);
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationId, target.id);
    assert.equal(requests[0].replyToMessageId, answers[0]);

    // Message actions → Save puts the message in Later → Saved, as the same
    // kind of card as a saved result, with Reply on it.
    await answer
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
    await expect(dialog()).toHaveAttribute("aria-label", "Message");
    await dialog()
      .getByRole("group", { name: "Main actions" })
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(answer.locator(".saved-mark")).toBeVisible();
    // Saving confirms with Undo, which removes exactly that save.
    const toast = page.locator(".action-toast");
    await expect(toast).toContainText("Saved.");
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(answer.locator(".saved-mark")).toHaveCount(0);
    await expect(toast).toContainText("Undone.");
    await answer
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
    await dialog()
      .getByRole("group", { name: "Main actions" })
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(answer.locator(".saved-mark")).toBeVisible();
    await dismissToast();
    await closeThread();
    await nav("Your profile").click();
    await laterTab("Saved").click();
    await expect(laterTab("Saved")).toHaveAttribute("aria-selected", "true");
    const kept = later
      .locator(".feed-card")
      .filter({ hasText: target.title });
    await expect(kept).toHaveCount(1);
    await expect(kept).toContainText("Finding 1");
    await capture("later-saved");
    await kept.getByRole("link", { name: "Open conversation", exact: true }).click();
    await expect(thread()).toHaveAttribute("aria-label", target.title);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("message"))
      .toBe(answers[0]);
    await expect(answer).toBeInViewport();
    await closeThread();
    // Reply on a saved message quotes it in its own thread.
    await kept.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread()).toHaveAttribute("aria-label", target.title);
    await expect(composer.locator(".composer-reply-chip")).toContainText(
      `Replying to @${agent.name}`,
    );
    // Your own prompts are replied to the same way, quoted as yours.
    await thread()
      .locator(`[id="message-${prompts[0]}"]`)
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await expect(composer.locator(".composer-reply-chip")).toContainText(
      "Replying to your message",
    );
    await closeThread();
    // Unsaving waits for its Undo: Undo keeps the card where it was.
    await kept
      .getByRole("button", { name: "Remove from Saved", exact: true })
      .click();
    await expect(kept).toHaveCount(0);
    await page
      .locator(".action-toast")
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(kept).toHaveCount(1);
    await kept
      .getByRole("button", { name: "Remove from Saved", exact: true })
      .click();
    await expect(kept).toHaveCount(0);
    await page
      .locator(".action-toast")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await fixture.api("/saved")).items.some(
          (item) => item.key === "m:" + answers[0],
        ),
      )
      .toBe(false);

    // A tapped notification hands its link to the open app (via the service
    // worker), which opens the thread at that message in place.
    await nav("Your profile").click();
    await page.evaluate(
      ({ conversation, message }) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "loop-open",
              url: `${location.origin}/?conversation=${conversation}&message=${message}`,
            },
          }),
        ),
      { conversation: target.id, message: answers[0] },
    );
    await expect(thread()).toHaveAttribute("aria-label", target.title);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("message"))
      .toBe(answers[0]);
    await expect(answer).toBeInViewport();
    await closeThread();

    // A reminder appears in Later while the completed result stays in Done.
    await nav("Feed").click();
    await expect(
      page.getByRole("tab", { name: "Done", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await row(snoozed.title).focus();
    await page.keyboard.press("Shift+F10");
    await expect(dialog()).toHaveAttribute("aria-label", snoozed.title);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await settled();
    await page
      .locator(".inbox-card")
      .filter({ has: row(snoozed.title) })
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await expect(dialog()).toHaveAttribute("aria-label", snoozed.title);
    await dialog()
      .getByRole("menuitem", { name: "Remind me", exact: true })
      .click();
    await expect(dialog()).toHaveAttribute("aria-label", "Remind me");
    await expect(dialog()).toContainText("Nothing is sent to an agent.");
    await dialog()
      .getByRole("button", { name: /^Tomorrow morning/ })
      .click();
    await settled();
    await expect(page.locator(".action-toast")).toContainText(
      "Reminder set: tomorrow morning.",
    );
    await expect(row(snoozed.title)).toHaveCount(1);
    await expect(row(target.title)).toHaveCount(1);
    await nav("Your profile").click();
    await laterTab("Reminders").click();
    const reminder = later
      .locator(".later-card")
      .filter({ hasText: snoozed.title });
    await expect(reminder).toHaveCount(1);
    await expect(reminder.locator(".eyebrow")).toContainText("Reminder");
    await expect(reminder.locator(".subline")).toContainText("Tomorrow at");
    await capture("later-snoozed");
    await reminder
      .getByRole("button", {
        name: `Cancel reminder for ${snoozed.title}`,
        exact: true,
      })
      .click();
    await expect(reminder).toHaveCount(0);
    await nav("Feed").click();
    await expect(row(snoozed.title)).toHaveCount(1);

    // The redesigned destinations fit small phones without sideways scroll
    // (the main design journey captures them at 390px).
    await page.setViewportSize({ width: 320, height: 780 });
    await nav("Feed").click();
    await row(target.title).waitFor();
    await capture("overflow-inbox-320");
    await nav("Your profile").click();
    for (const tab of ["Messages", "Saved", "Reminders", "Scheduled"]) {
      await laterTab(tab).click();
      await capture(
        `overflow-later-${tab.toLowerCase().replace(" ", "-")}-320`,
      );
    }
    await nav("Projects").click();
    const allProjects = page.getByRole("button", {
      name: "All projects",
      exact: true,
    });
    if (await allProjects.isVisible()) await allProjects.click();
    await page.locator(".project-tile").first().waitFor();
    await capture("overflow-projects-320");
    await nav("Search").click();
    await page.getByLabel("Search everything").fill("option");
    await page.getByLabel("Search everything").press("Enter");
    await page.locator(".search-result").first().waitFor();
    await capture("overflow-search-320");
    await page.goto(`${fixture.base}/?conversation=${target.id}`);
    await expect(thread().locator(".message").first()).toBeVisible();
    await capture("overflow-conversation-320");
    await closeThread();
  } finally {
    // These journeys are request-heavy; later checks share the fixture's
    // per-minute API budget, which is not what this smoke measures.
    fixture.db.prepare("DELETE FROM request_limits").run();
    await page.setViewportSize({ width: 390, height: 844 });
    const { due, upcoming } = await fixture.api("/later");
    for (const item of [...due, ...upcoming])
      if (item.target_id === snoozed.id)
        await fixture.api("/later/" + item.id, undefined, "DELETE");
    await fixture
      .api(`/messages/${answers[0]}/saved`, undefined, "DELETE")
      .catch(() => {});
    fixture.db
      .prepare(
        "DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))",
      )
      .run(JSON.stringify([...prompts, ...answers]));
  }
  console.log(
    "Feed threads, in-thread replies, saved messages, outline and snooze passed",
  );
}
