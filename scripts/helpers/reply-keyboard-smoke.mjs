import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openAgentProfile, openSettings } from "./browser-ui.mjs";

export async function replyKeyboardSmoke(page, fixture, capture) {
  const sheet = () => page.locator("dialog[open]").last();
  const thread = () => page.locator("dialog.conversation-sheet[open]");
  const composer = () => thread().locator(".composer");
  // Replies stay inside the thread; leaving the reply closes the thread.
  const close = () =>
    thread()
      .locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
  const resetViewport = () =>
    page.evaluate(() => {
      delete window.visualViewport.height;
      delete window.visualViewport.offsetTop;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
  try {
    for (const kind of ["result", "message"]) {
      await page.setViewportSize({ width: 390, height: 844 });
      if (kind === "message") {
        await page.goto(
          fixture.base + "/?conversation=" + fixture.conversations[0].id,
          { waitUntil: "networkidle" },
        );
        await sheet()
          .getByRole("button", { name: /^Open @.* profile$/ })
          .click();
        await page.getByRole("tab", { name: "Messages", exact: true }).click();
        await page
          .locator(".agent-message-actions")
          .first()
          .getByRole("button", { name: "Reply", exact: true })
          .click();
      } else {
        // Result cards live on their author's profile.
        const author = fixture.db
          .prepare(
            "SELECT g.name FROM agents g JOIN artifacts a ON a.agent_id=g.id WHERE a.id=?",
          )
          .get(fixture.artifacts[0]).name;
        await page.goto(fixture.base, { waitUntil: "networkidle" });
        await openAgentProfile(page, author);
        await page
          .locator(".feed-card:not(.inbox-card)")
          .first()
          .getByRole("button", { name: "Reply", exact: true })
          .click();
      }
      const input = composer().getByRole("textbox", { name: "Reply to agent" });
      // Replying opens the thread with the original quoted in the composer.
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await expect(composer().locator(".composer-reply-chip")).toBeVisible();
      await input.fill("Everything runs locally. Can you clarify this part?");
      // The quote starts as a one-line chip; expanding it shows the original.
      for (const quote of ["collapsed", "expanded"]) {
        if (quote === "expanded")
          await composer().locator(".composer-quote-toggle > summary").click();
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          for (const offsetTop of [0, 370]) {
            // A top-layer dialog can have a different origin than the page.
            // Emulate both directions; setting visualViewport alone never
            // reproduced the disappearing conversation on physical iPhones.
            await thread().evaluate((el, offsetTop) => {
              el.style.marginTop = (offsetTop ? 480 : -480) + "px";
            }, offsetTop);
            // iOS keeps the layout viewport tall while the keyboard shrinks and
            // pans the visual viewport. Resizing the browser alone misses this.
            await page.evaluate((offsetTop) => {
              Object.defineProperty(window.visualViewport, "height", {
                configurable: true,
                value: 430,
              });
              Object.defineProperty(window.visualViewport, "offsetTop", {
                configurable: true,
                value: offsetTop,
              });
              window.visualViewport.dispatchEvent(new Event("resize"));
              window.visualViewport.dispatchEvent(new Event("scroll"));
            }, offsetTop);
            await input.press("End");
            await input.press("!");
            await expect
              .poll(
                () =>
                  composer().evaluate((dialog, quote) => {
                    const v = window.visualViewport;
                    const top = v.offsetTop;
                    const bottom = top + v.height;
                    const content = dialog.querySelector(".composer-quote");
                    const within = (element) => {
                      const r = element.getBoundingClientRect();
                      return r.top >= top && r.bottom <= bottom && r.height > 0;
                    };
                    if (quote === "collapsed")
                      return (
                        within(dialog.querySelector(".composer-reply-chip")) &&
                        within(dialog.querySelector(".composer-main")) &&
                        within(dialog.querySelector(".composer-actions"))
                      );
                    const original = content.querySelector(
                      ".markdown > :first-child",
                    );
                    return (
                      within(dialog.querySelector(".composer-reply-chip")) &&
                      within(dialog.querySelector(".composer-main")) &&
                      within(content) &&
                      content.clientHeight >= 60 &&
                      within(original) &&
                      original.getBoundingClientRect().bottom <=
                        content.getBoundingClientRect().bottom
                    );
                  }, quote),
                {
                  message: `Reply chip, ${quote} original and textbox stay above the keyboard (${kind}, ${width}px, offset ${offsetTop})`,
                },
              )
              .toBe(true);
            await expect(input).toBeFocused();
            await expect(thread()).toHaveCSS("transform", "none");
            // Descendant bounds alone can pass inside a collapsed, clipping
            // dialog. Check the sheet's usable area and the field's hit target.
            await expect
              .poll(
                () =>
                  thread().evaluate((el) => {
                    const top = window.visualViewport.offsetTop;
                    const bottom = top + window.visualViewport.height;
                    const r = el.getBoundingClientRect();
                    const header = el
                      .querySelector(".sheet-head")
                      .getBoundingClientRect();
                    const actions = el
                      .querySelector(".composer-actions")
                      .getBoundingClientRect();
                    const input = el.querySelector(".composer textarea");
                    const field = input.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                      field.left + field.width / 2,
                      field.top + field.height / 2,
                    );
                    // Name the part that failed: a bare false here costs an
                    // artifact dig to find out which of these it was.
                    const checks = {
                      "sheet starts inside the viewport": r.top >= top,
                      "sheet ends inside the viewport": r.bottom <= bottom + 1,
                      "sheet has usable height": r.height > 100,
                      "header is inside the sheet":
                        header.top >= r.top && header.bottom <= r.bottom,
                      "reply field is inside the sheet":
                        field.top >= r.top && field.bottom <= r.bottom,
                      "reply controls are inside the sheet":
                        actions.top >= r.top && actions.bottom <= r.bottom,
                      "reply field is what you touch": input.contains(hit),
                    };
                    const failed = Object.entries(checks)
                      .filter(([, ok]) => !ok)
                      .map(
                        ([name]) =>
                          `${name} (sheet ${Math.round(r.top)}-${Math.round(r.bottom)}, header ${Math.round(header.top)}-${Math.round(header.bottom)}, field ${Math.round(field.top)}-${Math.round(field.bottom)}, controls ${Math.round(actions.top)}-${Math.round(actions.bottom)}, viewport ${top}-${bottom})`,
                      );
                    return failed.length ? failed.join("; ") : "";
                  }),
                {
                  message:
                    "Conversation has usable height with its header and reply field visible inside it",
                },
              )
              .toBe("");
            await capture(
              `reply-${kind}-keyboard-${quote}-${width}-${offsetTop}`,
            );
          }
        }
      }
      // The whole original message remains independently scrollable while the
      // keyboard is open; scrolling it must not move the author or composer.
      const headerBefore = await composer()
        .locator(".composer-reply-chip")
        .boundingBox();
      const replyBefore = await input.boundingBox();
      await composer()
        .locator(".composer-quote")
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      assert(
        await composer()
          .locator(".composer-quote")
          .evaluate((el) => el.scrollTop > 0),
        "The complete original message can be read while replying",
      );
      assert.equal(
        (await composer().locator(".composer-reply-chip").boundingBox()).y,
        headerBefore.y,
      );
      assert.equal((await input.boundingBox()).y, replyBefore.y);
      const draft = await input.inputValue();
      await thread().evaluate((el) => el.style.removeProperty("margin-top"));
      await input.blur();
      await expect(page.locator(".mobile-nav")).toBeVisible();
      await resetViewport();
      await expect(input).toHaveValue(draft);
      // After the keyboard, Safari can leave the layout viewport ending
      // above the screen's bottom. The thread follows the visible bottom
      // instead of leaving the Feed showing beneath it.
      const threadBottom = async () => {
        const box = await thread().boundingBox();
        return box.y + box.height;
      };
      const resting = await threadBottom();
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, "offsetTop", {
          configurable: true,
          get: () => 300,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect
        .poll(threadBottom, {
          message: "The thread follows the visible bottom",
        })
        .toBeCloseTo(resting + 300, 0);
      await capture(`reply-${kind}-dropped-viewport`);
      await resetViewport();
      await expect.poll(threadBottom).toBeCloseTo(resting, 0);
      await input.fill("");
      await composer()
        .getByRole("button", { name: "Clear reply context" })
        .click();
      await close();
      // Profiles remember their last tab; leave this one on its default
      // Results view for the smokes that follow.
      if (kind === "message")
        await page.getByRole("tab", { name: "Results", exact: true }).click();
    }
    // The settings side panel already spans the full height: the drop
    // leaves it in place instead of opening a gap at the top.
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await openSettings(page);
    const panel = page.locator("dialog.side-panel[open]");
    // Measure once it has slid in.
    await panel.evaluate((el) =>
      Promise.all(el.getAnimations().map((a) => a.finished)),
    );
    const before = await panel.boundingBox();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "offsetTop", {
        configurable: true,
        get: () => 300,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--viewport-drop"),
        ),
      )
      .toBe("300px");
    assert.deepEqual(
      await panel.boundingBox(),
      before,
      "The settings panel stays put when the viewport drops",
    );
    await resetViewport();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  } finally {
    await resetViewport();
    await page.setViewportSize({ width: 390, height: 844 });
  }
}
