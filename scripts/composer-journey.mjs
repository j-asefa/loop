import Database from "better-sqlite3";
import { closeSheets, openSettings } from "./helpers/browser-ui.mjs";
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
    await openSettings(page);
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
      const triggerButton = page.getByRole("button", {
        name: trigger,
        exact: true,
      });
      if (trigger === "Add attachments") {
        const bounds = await triggerButton.boundingBox();
        await page.mouse.move(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        await page.mouse.down();
        // Blurring on pointerdown moves the keyboard-anchored control before
        // pointerup, losing the tap on WebKit. Focus lasts until the click.
        await expect(page.getByLabel("Message your agent")).toBeFocused();
        await page.mouse.up();
      } else {
        await triggerButton.click();
      }
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
      // Closing the picker returns focus to the composer, which can move the
      // dock as WebKit settles; tap Minimize again if that tap was lost.
      await expect(async () => {
        if (!(await openComposer.isVisible()))
          await page
            .getByRole("button", { name: "Collapse composer" })
            .click({ timeout: 2000 });
        await expect(openComposer).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15000 });
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
    // After the keyboard or an app switch, Safari can leave what you see
    // below the layout viewport the bars are fixed to. Coming back to the
    // app, the tab bar and composer button follow the visible bottom edge.
    const navBottom = async () => {
      const box = await page.locator(".mobile-nav").boundingBox();
      return box.y + box.height;
    };
    const restingBottom = await navBottom();
    await page.evaluate(() => {
      document.activeElement?.blur?.();
      Object.defineProperty(window.visualViewport, "offsetTop", {
        configurable: true,
        get: () => 300,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(navBottom, { message: "The tab bar follows the visible bottom" })
      .toBeCloseTo(restingBottom + 300, 0);
    const droppedDock = await page.locator(".composer-dock").boundingBox();
    const droppedNav = await page.locator(".mobile-nav").boundingBox();
    assert.ok(
      Math.abs(droppedDock.y + droppedDock.height - droppedNav.y) < 2,
      "The composer button moves down with the tab bar",
    );
    await page.evaluate(() => {
      delete window.visualViewport.offsetTop;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect.poll(navBottom).toBeCloseTo(restingBottom, 0);
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
    const storageKey = "loop-draft";
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

      if (reply) {
        // Recover a lost acknowledgement across the old conversation composer
        // and the shared composer, without creating a second run.
        await page.evaluate(
          async ({ conversationId, agentId, prompt, key }) => {
            sessionStorage.removeItem("loop-draft");
            sessionStorage.removeItem("loop-draft-context");
            sessionStorage.removeItem("loop-draft-receipt");
            // Thread drafts persist per signed-in owner and thread.
            const session = await (await fetch("/api/auth/get-session")).json();
            localStorage.setItem(
              `loop-draft-text:${session.user.id}:${conversationId}`,
              prompt,
            );
            sessionStorage.setItem(
              "loop-receipt-" + conversationId,
              JSON.stringify({
                signature: JSON.stringify([
                  conversationId,
                  agentId,
                  prompt,
                  [],
                ]),
                key,
              }),
            );
          },
          {
            conversationId,
            agentId: agent.id,
            prompt,
            key: attempts[0].idempotencyKey,
          },
        );
      }
      // A slow thread load must not let the empty composer overwrite the
      // saved draft before it is restored.
      const threadLoad = new RegExp(`/api/conversations/${conversationId}(\\?|$)`);
      const slow = async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        // A later navigation may have cancelled the request meanwhile.
        await route.continue().catch(() => {});
      };
      if (reply) await page.route(threadLoad, slow);
      await page.reload();
      if (!reply)
        await page.getByRole("button", { name: "Compose a message" }).click();
      await expect(input).toHaveValue(prompt);
      if (reply) await page.unroute(threadLoad, slow);

      // Keep the post-send refresh pending: dismissal must not wait for it.
      await page.route("**/api/bootstrap", refresh);
      await send.click();
      await expect.poll(() => refreshing).toBe(true);
      if (reply) {
        // Sending from a thread keeps the thread open with an empty composer.
        await expect(page.locator("dialog.swipe-sheet")).toBeVisible();
        await expect(input).toHaveValue("");
        assert.equal(
          new URL(page.url()).searchParams.get("conversation"),
          conversationId,
        );
        await expect
          .poll(() =>
            page.evaluate(
              (id) =>
                Object.keys(localStorage).find(
                  (k) => k.startsWith("loop-draft-text:") && k.endsWith(":" + id),
                ) ?? null,
              conversationId,
            ),
          )
          .toBe(null);
      } else {
        await expect(page.locator("dialog[open]").last()).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Compose a message" }),
        ).toBeVisible();
        assert.equal(
          new URL(page.url()).searchParams.has("conversation"),
          false,
        );
      }
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
  await expect(page.locator(".composer textarea")).toHaveValue("");
  await page.getByRole("button", { name: "Collapse composer" }).click();
  console.log(
    "PASS: messages collapse and replies stay in their thread before refresh, lost-response retries preserve drafts without duplicate runs, and sent drafts stay cleared when reopened.",
  );
}

export async function scheduledSendJourney(page, api, dir) {
  const base = new URL(page.url()).origin;
  // Earlier journeys share this fixture user's per-minute request budget.
  if (dir) {
    const limits = new Database(join(dir, "loop.db"));
    limits.pragma("busy_timeout = 10000");
    limits.prepare("DELETE FROM request_limits").run();
    limits.close();
  }
  const sent = (await api("/runs")).find(
    (r) => r.input === "Collapse after this reply",
  );
  const conversationId = sent.conversation_id;
  const scheduled = async () =>
    (
      await api(
        "/scheduled-sends?conversation=" + encodeURIComponent(conversationId),
      )
    ).items;
  await page.goto(base + "/?conversation=" + conversationId);
  const thread = page.locator("dialog.swipe-sheet");
  const input = thread.getByLabel("Reply to agent");
  const later = thread.getByRole("button", { name: "Send later", exact: true });
  await expect(input).toBeVisible();
  // Nothing to schedule yet, so the thread composer leaves the clock out.
  await expect(later).toHaveCount(0);

  // "Send later at a time…" confirms recipient, project, thread and time,
  // then schedules a message that waits in the thread until then.
  await input.fill("Scheduled fixture follow-up");
  await later.click();
  const options = page.getByRole("dialog", {
    name: "Send options",
    exact: true,
  });
  await expect(
    options.getByRole("menuitem", { name: /^(Send now|Steer current task)/ }),
  ).toBeVisible();
  await options
    .getByRole("menuitem", { name: /^Send later at a time/ })
    .click();
  const schedule = page.getByRole("dialog", {
    name: "Send later",
    exact: true,
  });
  await expect(schedule.locator(".send-summary")).toContainText(
    "Scheduled fixture follow-up",
  );
  const at = await page.evaluate(() => {
    const d = new Date(Date.now() + 2 * 3600_000);
    d.setSeconds(0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    return {
      value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      time: d.getTime(),
    };
  });
  await schedule.getByLabel(/^Send at/).fill(at.value);
  await schedule.getByRole("button", { name: /^Schedule for/ }).click();
  await expect(schedule).toBeHidden();
  // The thread stays open, the composer clears and the message is listed.
  await expect(thread).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(page.locator(".action-toast")).toContainText("Scheduled for @");
  const pending = thread.getByRole("region", { name: "Scheduled messages" });
  await expect(pending).toContainText("Scheduled fixture follow-up");
  const items = await scheduled();
  assert.equal(items.length, 1);
  assert.equal(items[0].input, "Scheduled fixture follow-up");
  assert.equal(items[0].send_at, at.time);
  assert.equal(
    (await api("/runs")).filter(
      (r) => r.input === "Scheduled fixture follow-up",
    ).length,
    0,
    "A scheduled message does not start a run early",
  );
  // It survives reopening the thread, and cancelling removes it.
  await page.reload();
  await expect(pending).toContainText("Scheduled fixture follow-up");
  await pending
    .getByRole("button", { name: "Cancel scheduled message", exact: true })
    .click();
  await expect(pending).toHaveCount(0);
  await expect.poll(async () => (await scheduled()).length).toBe(0);

  // "Queue after …" queues rather than steering.
  const posted = [];
  const record = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/runs"
    )
      posted.push(request.postDataJSON());
  };
  page.on("request", record);
  try {
    await input.fill("Queued fixture follow-up");
    await later.click();
    await options
      .getByRole("menuitem", { name: /^Queue after (this task|current work)/ })
      .click();
    await expect(page.locator(".action-toast")).toContainText(
      "Queued after the current task.",
    );
    await expect(thread).toBeVisible();
    await expect(input).toHaveValue("");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].queue, true);
    assert.equal(posted[0].conversationId, conversationId);
    await expect(
      thread.locator("article.message").filter({
        hasText: "Queued fixture follow-up",
      }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await api("/runs")).find(
            (r) => r.input === "Queued fixture follow-up",
          )?.state,
      )
      .toBe("completed");
  } finally {
    page.off("request", record);
  }
  await closeSheets(page);

  // Scheduled from the Feed's composer (a new thread), the message is found
  // in Later → Scheduled after a reload, and can be edited and cancelled.
  await page.goto(base + "/");
  await page.getByRole("button", { name: "Compose a message" }).click();
  const message = page.getByLabel("Message your agent");
  await message.fill("Global scheduled kickoff");
  await page.getByRole("button", { name: "Send later", exact: true }).click();
  await options
    .getByRole("menuitem", { name: /^Send later at a time/ })
    .click();
  await expect(schedule.locator(".send-summary")).toContainText("New thread");
  await schedule.getByLabel(/^Send at/).fill(at.value);
  await schedule.getByRole("button", { name: /^Schedule for/ }).click();
  const confirmation = page.locator(".action-toast");
  await expect(confirmation).toContainText("Scheduled for @");
  await expect(
    confirmation.getByRole("button", { name: "View", exact: true }),
  ).toBeVisible();
  const everywhere = async () =>
    (await api("/scheduled-sends")).items.filter(
      (item) => item.input.startsWith("Global scheduled"),
    );
  await expect.poll(async () => (await everywhere()).length).toBe(1);
  await page.reload();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "You", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Your profile", exact: true })
    .getByRole("tab", { name: /^Scheduled/ })
    .click();
  const outbox = page
    .getByRole("region", { name: "Later", exact: true })
    .getByRole("region", { name: "Scheduled messages" });
  const entry = outbox
    .locator("article")
    .filter({ hasText: "Global scheduled kickoff" });
  await expect(entry).toContainText("To @");
  await entry
    .getByRole("button", { name: "Edit scheduled message", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Edit scheduled message",
    exact: true,
  });
  await editor.getByLabel("Message").fill("Global scheduled kickoff, edited");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(outbox).toContainText("Global scheduled kickoff, edited");
  assert.equal(
    (await everywhere())[0].input,
    "Global scheduled kickoff, edited",
  );
  await outbox
    .locator("article")
    .filter({ hasText: "Global scheduled kickoff, edited" })
    .getByRole("button", { name: "Cancel scheduled message", exact: true })
    .click();
  await expect.poll(async () => (await everywhere()).length).toBe(0);
  // With your profile already open on another tab, View on a new scheduled
  // message switches it to Scheduled and highlights that message.
  const profile = page.getByRole("region", { name: "Your profile", exact: true });
  await profile.getByRole("tab", { name: "Messages", exact: true }).click();
  await page.getByRole("button", { name: "Compose a message" }).click();
  await message.fill("Global scheduled from the profile");
  await page.getByRole("button", { name: "Send later", exact: true }).click();
  await options
    .getByRole("menuitem", { name: /^Send later at a time/ })
    .click();
  await schedule.getByLabel(/^Send at/).fill(at.value);
  await schedule.getByRole("button", { name: /^Schedule for/ }).click();
  await confirmation.getByRole("button", { name: "View", exact: true }).click();
  await expect(
    profile.getByRole("tab", { name: /^Scheduled/ }),
  ).toHaveAttribute("aria-selected", "true");
  const anchored = outbox.locator(".scheduled-message.anchored");
  await expect(anchored).toHaveCount(1);
  await expect(anchored).toContainText("Global scheduled from the profile");
  await anchored
    .getByRole("button", { name: "Cancel scheduled message", exact: true })
    .click();
  await expect.poll(async () => (await everywhere()).length).toBe(0);
  console.log(
    "PASS: Send later at a time… confirms and schedules an in-thread message that survives reload and cancels cleanly; a message scheduled from the Feed is edited and cancelled in Later → Scheduled after a reload; View on a message scheduled with the profile open switches it to Scheduled at that message; Queue after this task queues in the open thread (fixtures).",
  );
}
