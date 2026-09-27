import { closeSheets } from "./helpers/browser-ui.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function composerJourney(page, api) {
  const { agents, folders } = await api("/bootstrap");
  const manager = agents.find((a) => a.name === "creation-idle"),
    worker = agents.find((a) => a.name === "creation-starter");
  const longName =
    "Product research and design for the next generation of the workspace";
  for (const name of [
    longName,
    ...Array.from({ length: 14 }, (_, i) => `Research team ${i + 1}`),
  ])
    await api("/teams", { name, managerId: manager.id, members: [worker.id] });
  // Reproduce going offline after render but before the effect subscribes.
  await page.evaluate(() =>
    sessionStorage.setItem("loop-test-offline-on-subscribe", "1"),
  );
  await page.addInitScript(() => {
    if (sessionStorage.getItem("loop-test-offline-on-subscribe") !== "1")
      return;
    const add = window.addEventListener;
    window.addEventListener = function (type, listener, options) {
      if (type === "offline") {
        sessionStorage.removeItem("loop-test-offline-on-subscribe");
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          value: false,
        });
        window.dispatchEvent(new Event("offline"));
        window.addEventListener = add;
      }
      return add.call(this, type, listener, options);
    };
  });
  await page.reload();
  await expect(page.locator(".pwa-status")).toContainText("offline");
  await page.evaluate(() => {
    delete navigator.onLine;
    window.dispatchEvent(new Event("online"));
  });
  const picker = page.getByRole("button", { name: /^Filter by team:/ });
  const openComposer = page.getByRole("button", { name: "Compose a message" });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    // Offline/update notices share this banner. It must leave Settings usable.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await expect(page.locator(".pwa-status")).toBeVisible();
    const notice = await page.locator(".pwa-status").boundingBox();
    const header = await page.locator(".topbar").boundingBox();
    assert.ok(
      notice.y + notice.height <= header.y,
      "Status notice leaves header controls uncovered",
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.evaluate(() => {
      delete navigator.onLine;
      window.dispatchEvent(new Event("online"));
    });

    await picker.click();
    await page.getByLabel("Search teams").fill("next generation");
    await page.getByRole("checkbox", { name: longName, exact: true }).check();
    await page.getByLabel("Search teams").fill("Research team 14");
    await page
      .getByRole("checkbox", { name: "Research team 14", exact: true })
      .check();
    await page.getByLabel("Search teams").fill("");
    const list = page.locator(".team-options");
    assert.ok(await list.evaluate((el) => el.scrollHeight > el.clientHeight));
    await page.screenshot({
      path: join(tmpdir(), `loop-team-picker-${width}.png`),
    });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(picker).toHaveText("2 teams");
    assert.ok((await picker.boundingBox()).height <= 48);
    await picker.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^All teams/ })
      .click();
    await page.getByRole("button", { name: "Done", exact: true }).click();

    await openComposer.click();
    await page.getByLabel("Agent recipient").selectOption(manager.id);
    await expect(
      page.locator(".composer").getByLabel("Project", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel("Message your agent")
      .fill("Keep this draft while I choose a team.");
    for (const control of [
      page.getByLabel("Agent recipient"),
      page.getByRole("button", {
        name: "Select model and effort",
        exact: true,
      }),
      page.getByRole("button", { name: "Send message", exact: true }),
      page.getByRole("button", { name: "Add attachments", exact: true }),
    ])
      assert.ok(
        (await control.boundingBox()).height >= 44,
        "Touch controls are at least 44px tall",
      );
    assert.equal(
      await page
        .locator(".composer")
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    );
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await page.screenshot({
        path: join(tmpdir(), `loop-composer-${width}-${theme}.png`),
      });
    }
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        get: () => innerHeight - 350,
      });
      Object.defineProperty(window.visualViewport, "offsetTop", {
        configurable: true,
        get: () => 0,
      });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator(".mobile-nav")).toBeHidden();
    const composer = await page.locator(".composer").boundingBox();
    assert.ok(
      composer.y >= 0 && composer.y + composer.height <= 494,
      "Composer fits above a 350px keyboard",
    );
    await page.screenshot({
      path: join(tmpdir(), `loop-composer-keyboard-${width}.png`),
      clip: { x: 0, y: 0, width, height: 494 },
    });
    // iOS can leave visualViewport at its old keyboard height after blur.
    // Closing the composer must restore the dock and navigation without resize.
    await page.getByRole("button", { name: "Collapse composer" }).click();
    await expect(page.locator(".mobile-nav")).toBeVisible();
    const dock = await page.locator(".composer-dock").boundingBox();
    const nav = await page.locator(".mobile-nav").boundingBox();
    assert.ok(
      Math.abs(dock.y + dock.height - nav.y) < 2,
      "The collapsed composer returns directly above navigation after blur",
    );
    await page.screenshot({
      path: join(tmpdir(), `loop-composer-dismissed-keyboard-${width}.png`),
    });

    // Opening a picker while typing must clear the same stale keyboard inset.
    for (const [trigger, title] of [
      ["Select model and effort", "Select model"],
      ["Add attachments", "Add to message"],
    ]) {
      await openComposer.click();
      await page.getByLabel("Message your agent").focus();
      await expect(page.locator(".mobile-nav")).toBeHidden();
      await page.getByRole("button", { name: trigger, exact: true }).click();
      const sheet = page.locator("dialog[open]").last();
      await expect(
        sheet.getByRole("heading", { name: title, exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(page.locator(".mobile-nav")).toBeVisible();
      assert.ok(
        Math.abs(
          (await sheet.boundingBox()).y +
            (await sheet.boundingBox()).height -
            844,
        ) < 2,
        "The picker is anchored to the screen, not the dismissed keyboard",
      );
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Collapse composer" }).click();
      await expect(page.locator(".mobile-nav")).toBeVisible();
    }
    // Zooming shrinks the visual viewport too, but must not raise the composer.
    await openComposer.click();
    await page.getByLabel("Message your agent").focus();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "scale", {
        configurable: true,
        get: () => 2,
      });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator(".mobile-nav")).toBeVisible();
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--keyboard-inset"),
      ),
      "0px",
    );
    await page.evaluate(() => {
      delete window.visualViewport.height;
      delete window.visualViewport.offsetTop;
      delete window.visualViewport.scale;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.getByRole("button", { name: "Collapse composer" }).click();
    await picker.click();
    await closeSheets(page);
    await expect(picker).toBeFocused();
    await openComposer.click();
    await expect(page.getByLabel("Message your agent")).toHaveValue(
      "Keep this draft while I choose a team.",
    );
    await page.getByRole("button", { name: "Collapse composer" }).click();
  }
  console.log(
    "PASS: searchable, scroll-contained team selection; compact multi-team summary; 44px composer controls; phone layouts in both themes; simulated keyboard inset; focus restoration and draft preservation.",
  );
}

export async function sendCollapseJourney(page, api) {
  const base = new URL(page.url()).origin;
  const agent = (await api("/bootstrap")).agents.find(
    (a) => a.name === "creation-idle",
  );
  let conversationId;
  for (const reply of [false, true]) {
    await page.goto(base + (reply ? "/?conversation=" + conversationId : "/"));
    if (!reply) {
      await page.getByRole("button", { name: "Compose a message" }).click();
      await page.getByLabel("Agent recipient").selectOption(agent.id);
    }
    const input = page.getByLabel(
      reply ? "Reply to agent" : "Message your agent",
    );
    const send = page.getByRole("button", {
      name: reply ? "Send reply" : "Send message",
      exact: true,
    });
    const prompt = reply
      ? "Collapse after this reply"
      : "Collapse after this message";
    const storageKey = reply
      ? "loop-conversation-" + conversationId
      : "loop-draft";
    await input.fill(prompt);

    // A lost acknowledgement must retain the draft and retry the same saved run.
    const attempts = [];
    let accepted;
    const submit = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      accepted = await response.json();
      if (attempts.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    };
    await page.route("**/api/runs", submit);
    let releaseRefresh;
    const held = new Promise((resolve) => (releaseRefresh = resolve));
    let refreshing = false;
    const refresh = async (route) => {
      refreshing = true;
      await held;
      await route.continue();
    };
    try {
      await send.click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(input).toBeVisible();
      await expect(input).toHaveValue(prompt);
      await expect(send).toBeEnabled();
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
        prompt,
      );

      // Keep the post-send refresh pending: dismissal must not wait for it.
      await page.route("**/api/bootstrap", refresh);
      await send.click();
      await expect.poll(() => refreshing).toBe(true);
      await expect(page.locator("dialog[open]").last()).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Compose a message" }),
      ).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.has("conversation"), false);
      assert.notEqual(
        await page.evaluate(() => document.activeElement?.tagName),
        "TEXTAREA",
      );
      await expect
        .poll(() =>
          page.evaluate((key) => sessionStorage.getItem(key) || "", storageKey),
        )
        .toBe("");
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
      assert.equal(
        (await api("/runs")).filter((r) => r.input === prompt).length,
        1,
      );
      conversationId = accepted.conversation_id;
    } finally {
      const resumed = refreshing
        ? page.waitForResponse(
            (r) => new URL(r.url()).pathname === "/api/bootstrap",
          )
        : null;
      releaseRefresh();
      if (resumed) await (await resumed).finished();
      await page.unroute("**/api/bootstrap", refresh);
      await page.unroute("**/api/runs", submit);
    }
  }
  await page.goto(base + "/?conversation=" + conversationId);
  await expect(page.getByLabel("Reply to agent")).toHaveValue("");
  await closeSheets(page);
  await page.getByRole("button", { name: "Compose a message" }).click();
  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  await page.getByRole("button", { name: "Collapse composer" }).click();
  console.log(
    "PASS: messages and replies collapse before refresh, lost-response retries preserve drafts without duplicate runs, and sent drafts stay cleared when reopened.",
  );
}
