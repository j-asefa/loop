import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// The real conversation and question form, with decisions intercepted so this
// never answers a live harness request. Visibility alone misses composer overlap.
export async function nativeQuestionLayoutSmoke(page, fixture, capture) {
  const branchQuestion = {
    id: "branch",
    title:
      "The remote has no `master` branch; its default branch is `main`. Should I push this fix to `main`, or create a new `master` branch?",
    options: ["Push to main", "Create master"],
  };
  const extraQuestions = [
    {
      id: "checks",
      title: "Which checks should run before publishing the change?",
      multiple: true,
      options: [
        "Check that long questions and their answers remain readable on a small phone screen",
        "Check that the response can be sent while the phone keyboard is open",
        "Check the wider conversation layout on a tablet",
      ],
    },
    { id: "notes", title: "Anything else to include in the change?" },
  ];
  let pending = [];
  const responses = [];
  await page.route("**/api/native/decisions**", async (route) => {
    if (route.request().method() === "POST") {
      responses.push(route.request().postDataJSON());
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      pending = pending.filter((item) => item.id !== id);
      return route.fulfill({ json: { state: "resolved" } });
    }
    await route.fulfill({ json: pending });
  });
  const decision = (questions, id = "layout-question") => ({
    id,
    run_id: "layout-question-run",
    conversation_id: fixture.conversations[0].id,
    generation: "layout-question-generation",
    native_id: id,
    command_id: null,
    digest: null,
    created_at: Date.now(),
    name: "winter",
    provider: "codex",
    input: "Review the question layout fixture",
    state: "pending",
    request: JSON.stringify({
      id,
      kind: "question",
      title: "Codex needs your input",
      questions,
    }),
  });
  const card = page.locator(".conversation-sheet .native-decision").first();
  const send = card.getByRole("button", { name: "Send response", exact: true });
  async function reachable(control) {
    // Navigation and composer metadata can change the pane after the first
    // scroll. Retry the scroll and all reachability checks within the same
    // five-second window; permanently clipped controls still fail.
    await expect(async () => {
      await control.evaluate((element) =>
        element.scrollIntoView({ block: "center", inline: "nearest" }),
      );
      await expect(control).toBeInViewport({ ratio: 1, timeout: 200 });
      const bounds = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const composer = document
          .querySelector(".conversation-composer")
          .getBoundingClientRect();
        const viewport = window.visualViewport;
        const body = document.querySelector(
          ".conversation-sheet > .sheet-inner > .sheet-body",
        );
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return {
          visible:
            rect.top >= viewport.offsetTop &&
            rect.bottom <= viewport.offsetTop + viewport.height + 1 &&
            rect.bottom <= composer.top + 1 &&
            body.scrollTop === 0 &&
            element.contains(hit),
          control: rect.toJSON(),
          composer: composer.toJSON(),
          viewport: { top: viewport.offsetTop, height: viewport.height },
          bodyScroll: body.scrollTop,
          hit: hit?.outerHTML.slice(0, 300),
        };
      });
      assert(
        bounds.visible,
        "Question controls must receive taps above the composer and keyboard without scrolling a clipped parent: " +
          JSON.stringify(bounds),
      );
    }).toPass({ timeout: 5000 });
  }
  for (const [width, height] of [
    [390, 844],
    [320, 568],
    [768, 600],
  ]) {
    for (const long of [true, false]) {
      await page.setViewportSize({ width, height });
      pending = [decision([branchQuestion, ...(long ? extraQuestions : [])])];
      const before = responses.length;
      await page.goto(
        `${fixture.base}/?conversation=${fixture.conversations[0].id}`,
      );
      await expect(send).toBeVisible();
      await reachable(send);
      const option = card.getByRole("radio", {
        name: "Push to main",
        exact: true,
      });
      await reachable(option);
      await option.check();
      assert(
        await option.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const label = element.closest("label").getBoundingClientRect();
          return rect.width <= 24 && rect.height <= 24 && label.height >= 44;
        }),
        "Compact option controls must keep a phone-sized label tap target",
      );
      const expected = { branch: ["Push to main"] };
      if (long) {
        for (const name of extraQuestions[0].options.slice(0, 2)) {
          const checkbox = card.getByRole("checkbox", { name, exact: true });
          await reachable(checkbox);
          await checkbox.check();
        }
        const notes = card.getByRole("textbox", {
          name: extraQuestions[1].title + " response",
          exact: true,
        });
        await reachable(notes);
        const initialHeight = await notes.evaluate(
          (element) => element.clientHeight,
        );
        const response =
          "Keep the Send button reachable. ".repeat(3) +
          "\nInclude the full response on multiple lines.";
        await notes.fill(response);
        assert(
          await notes.evaluate(
            (element) =>
              element.clientHeight > 70 &&
              element.scrollWidth <= element.clientWidth &&
              element.scrollHeight <= element.clientHeight + 2,
          ),
          "The response must grow and wrap as text is entered",
        );
        await notes.fill("Short answer");
        assert(
          (await notes.evaluate((element) => element.clientHeight)) <=
            initialHeight,
          "The response must shrink when text is removed",
        );
        await notes.fill(response);
        expected.checks = extraQuestions[0].options.slice(0, 2);
        expected.notes = [response];
        if (width < 700) {
          // A desktop runner cannot open the iPhone keyboard. Exercise the
          // production visual-viewport handling while the answer keeps focus.
          await page.evaluate(() => {
            Object.defineProperty(window.visualViewport, "height", {
              configurable: true,
              value: 350,
            });
            window.visualViewport.dispatchEvent(new Event("resize"));
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-keyboard",
            "open",
          );
          await reachable(notes);
          await expect(notes).toHaveValue(expected.notes[0]);
        }
      }
      assert.equal(
        responses.length,
        before,
        "Selecting an answer must not submit it",
      );
      await reachable(send);
      assert(
        await card.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
        "Questions and options must wrap inside the card",
      );
      await capture(`native-question-${width}-${long ? "long" : "short"}`);
      await send.click();
      await expect(card).toHaveCount(0);
      assert.equal(responses.length, before + 1);
      assert.deepEqual(responses.at(-1).answer, expected);
      assert(
        responses.at(-1).commandId,
        "Responses retain their dispatch identity",
      );
    }
  }
  // Separate pending requests share the same finite space above the composer.
  await page.setViewportSize({ width: 390, height: 844 });
  pending = [
    decision([branchQuestion], "first"),
    decision(extraQuestions, "second"),
  ];
  await page.goto(
    `${fixture.base}/?conversation=${fixture.conversations[0].id}`,
  );
  await expect(
    page.locator(".conversation-sheet .native-decision"),
  ).toHaveCount(2);
  await card.getByRole("radio", { name: "Create master", exact: true }).check();
  const notes = page
    .locator(".conversation-sheet .native-decision")
    .last()
    .getByRole("textbox", {
      name: extraQuestions[1].title + " response",
      exact: true,
    });
  await notes.fill("Keep this answer while responding to the first request.");
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 350,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "open");
  await reachable(notes);
  await reachable(send);
  await capture("native-questions-keyboard");
  await send.click();
  await expect(
    page.locator(".conversation-sheet .native-decision"),
  ).toHaveCount(1);
  assert.deepEqual(responses.at(-1).answer, { branch: ["Create master"] });
  assert.equal(pending[0].id, "second");
  await expect(notes).toHaveValue(
    "Keep this answer while responding to the first request.",
  );
}
