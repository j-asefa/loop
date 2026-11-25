import { expect } from "@playwright/test";
import { tsImport } from "tsx/esm/api";

// The changed-refresh step moves a result to another project through the
// existing conversation writer, not direct SQL.
const conversations = await tsImport(
  "../../src/server/sql/conversations.ts",
  import.meta.url,
);
// The activity step seeds one harness record through the existing writer.
const activities = await tsImport(
  "../../src/server/sql/agent-activities.ts",
  import.meta.url,
);
const { activityRecordKey } = await tsImport(
  "../../src/shared/agent-activities.ts",
  import.meta.url,
);
const { WORKING_RUN_DISPLAY_STATES } = await tsImport(
  "../../src/shared/run-state.ts",
  import.meta.url,
);

// Measures how quickly the Feed responds to touch, tab switches, drags and
// local writes, on the production bundle with a 4x CPU slowdown in Chromium.
// Each measurement is printed as JSON so changes can be compared before and
// after; budgets are asserted by the changes that meet them.

// React reports each commit to the developer-tools hook when one is present
// before it loads. Counting commits needs no change to the app itself. A
// "card render" is a Feed card wrapper element whose owning components did
// work in a commit; each card counts at most once per commit.
function installCommitProbe() {
  const state = { commits: 0, cardRenders: 0 };
  // The component's outermost element, depth first: a wrapper component may
  // render something without an element before it.
  const firstHost = (fiber) => {
    const stack = [fiber.child];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.tag === 5) return node.stateNode;
      stack.push(node.sibling, node.child);
    }
    return null;
  };
  const visit = (fiber, cards) => {
    for (let node = fiber; node; node = node.sibling) {
      // Function, forwardRef and memo components; PerformedWork is flag 1.
      if ([0, 11, 14, 15].includes(node.tag) && node.flags & 1) {
        const host = firstHost(node);
        if (host?.classList?.contains("feed-item-wrap")) cards.add(host);
      }
      // A subtree React skipped in this commit keeps its child pointer and
      // the flags from its last real render, so it is not visited (as React
      // developer tools do).
      if (node.child && node.child !== node.alternate?.child)
        visit(node.child, cards);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      state.commits++;
      try {
        const cards = new Set();
        visit(root.current, cards);
        state.cardRenders += cards.size;
      } catch {
        // Measurement only; never break the page.
      }
    },
  };
  window.__loopCommitProbe = state;
  // Pull to refresh announces itself with this event before it reloads.
  state.refreshes = 0;
  addEventListener("loop-refresh", () => state.refreshes++);
}

const summary = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    n: sorted.length,
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    p95: Math.round(
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    ),
  };
};

// Waits until no API request is in flight and React has not committed for
// 500 ms, so a refresh started by a gesture has finished before counting.
async function settle(page, inflight) {
  let last = -1,
    quietSince = Date.now();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const commits = await page.evaluate(() => window.__loopCommitProbe.commits);
    if (inflight.size || commits !== last) quietSince = Date.now();
    last = commits;
    if (Date.now() - quietSince >= 500) return;
    await page.waitForTimeout(100);
  }
  throw new Error("The Feed did not settle within 15 s");
}

// Cards re-render once a minute for their relative times. A window that
// counts card renders starts at least 20 s before the page's next minute,
// and the caller checks the minute did not change during it.
const pageMinute = (page) =>
  page.evaluate(() => Math.floor(Date.now() / 60000));
async function awayFromMinuteBoundary(page) {
  const left = await page.evaluate(() => 60000 - (Date.now() % 60000));
  if (left < 20000) await page.waitForTimeout(left + 250);
  return pageMinute(page);
}
// Feed may last have rendered in an earlier minute; its next render would
// then re-render every card for their times. Start a counting window clear
// of the minute boundary, with Feed rendered in the current minute.
async function minuteWindow(page, inflight) {
  const minute = await awayFromMinuteBoundary(page);
  for (const name of ["Working", "Done"])
    await page.getByRole("tab", { name: new RegExp("^" + name) }).click();
  await settle(page, inflight);
  return minute;
}
const sameMinute = async (page, minute, name) => {
  if ((await pageMinute(page)) !== minute)
    throw new Error(
      `The ${name} window crossed a minute boundary; its card renders are not comparable`,
    );
};

// Done results as the Feed API returns them: the title a card shows and its
// conversation.
async function doneResults(page) {
  return page.evaluate(async () => {
    const body = await (await fetch("/api/feed?filter=done")).json();
    return (body.items || body).map((item) => ({
      title: item.title,
      conversation: item.conversation_id,
    }));
  });
}
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A card's row is labelled with its title, then any status (", Done").
const rowNamed = (page, title) =>
  page.locator(".feed-results .feed-item-card").filter({
    has: page.getByRole("button", {
      name: new RegExp("^" + escapeRegExp(title) + "(, .*)?$"),
    }),
  });

// Time from pointerdown to the first frame whose computed style differs from
// rest. Resolves to null when nothing changes within 250 ms, well before a
// Done card's 500 ms long press would open its menu.
async function pressLatency(page, locator) {
  // Press a point that hit-tests to the target itself, not an overlapping
  // control, floating button or navigation bar.
  const point = await locator.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    for (const fx of [0.5, 0.3, 0.7])
      for (const fy of [0.5, 0.3, 0.7, 0.15]) {
        const x = rect.left + rect.width * fx,
          y = rect.top + rect.height * fy;
        // The nearest control under the point must be the target itself, not
        // a link or button inside it, which takes the press for itself.
        const hit = document
          .elementFromPoint(x, y)
          ?.closest('a, button, input, summary, [role="button"], [role="tab"]');
        if (hit === element) return { x, y };
      }
    return null;
  });
  if (!point) return "no-pointerdown";
  const handle = await locator.elementHandle();
  // Hover first: the resting style includes any hover style, so only the
  // press itself can change the signature.
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(120);
  await page.evaluate((element) => {
    const signature = () => {
      const style = getComputedStyle(element);
      return [
        style.transform,
        style.scale,
        style.opacity,
        style.backgroundColor,
        style.boxShadow,
        style.filter,
        style.color,
      ].join("|");
    };
    const rest = signature();
    window.__loopPress = new Promise((resolve) => {
      setTimeout(() => resolve("no-pointerdown"), 3000);
      element.addEventListener(
        "pointerdown",
        () => {
          const start = performance.now();
          const check = () => {
            if (signature() !== rest) return resolve(performance.now() - start);
            if (performance.now() - start > 250) return resolve(null);
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        },
        { once: true, capture: true },
      );
    });
  }, handle);
  await page.mouse.down();
  const latency = await page.evaluate(() => window.__loopPress);
  // Release away from the target so no click or navigation follows.
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await page.waitForTimeout(150);
  // On a slow machine the release can come after a Done card's 500 ms long
  // press, which opens the card menu. The sample was already taken, so close
  // the menu before the next step rather than measure on a modal page.
  const menu = page.locator("dialog[open]");
  if (await menu.count()) {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  return latency;
}

// Time from pointerdown on a tab to the first frame where that tab is
// selected and its list shows content rather than the loading placeholder.
async function tabSwitch(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp("^" + name) });
  const handle = await tab.elementHandle();
  await page.evaluate((element) => {
    const feed = document.querySelector('[aria-label="Feed"]') || document;
    window.__loopTab = new Promise((resolve) => {
      setTimeout(
        () => resolve({ ms: null, sawLoading: null, timedOut: true }),
        15000,
      );
      element.addEventListener(
        "pointerdown",
        () => {
          const start = performance.now();
          let sawLoading = false,
            frames = 0;
          const check = () => {
            const loading = !!feed.querySelector(".feed-loading");
            sawLoading ||= loading;
            if (element.getAttribute("aria-selected") === "true" && !loading)
              return resolve({ ms: performance.now() - start, sawLoading });
            if (++frames > 600) return resolve({ ms: null, sawLoading });
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        },
        { once: true, capture: true },
      );
    });
  }, handle);
  await tab.click();
  return page.evaluate(() => window.__loopTab);
}

// Frame intervals and React commits while a touch drag runs, before release.
// Counts from after touchStart: the budget is no commit per move, and a
// card may commit once as the finger lands (it prefetches its full answer).
async function dragProbe(page, client, from, to, steps, durationMs) {
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  await page.evaluate(() => {
    const probe = window.__loopCommitProbe;
    window.__loopDrag = { commits: probe.commits, frames: [], run: true };
    let last = performance.now();
    const tick = (now) => {
      if (!window.__loopDrag.run) return;
      window.__loopDrag.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          id: 1,
        },
      ],
    });
    await page.waitForTimeout(durationMs / steps);
  }
  const result = await page.evaluate(() => {
    const drag = window.__loopDrag;
    drag.run = false;
    const frames = drag.frames.slice(1);
    return {
      commits: window.__loopCommitProbe.commits - drag.commits,
      frames: frames.length,
      // A frame that took longer than 1.5 frames at 60 Hz dropped at least one.
      dropped: frames.filter((interval) => interval > 25).length,
    };
  });
  return result;
}

export async function responsivenessSmoke(page, fixture, engine) {
  // Timings use Chromium's CPU throttling and CDP touch input; WebKit has
  // neither, and its mouse input in a touch context sends no pointerdown.
  if (engine !== "chromium") {
    console.log(
      `responsiveness ${engine}: skipped (Chromium-only measurement)`,
    );
    return null;
  }
  await page.addInitScript(installCommitProbe);
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  const rows = page.locator(".feed-results .feed-row");
  await expect(rows.first()).toBeVisible();
  const chromium = engine === "chromium";
  const client = chromium ? await page.context().newCDPSession(page) : null;
  await client?.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const report = { engine, cpuThrottle: chromium ? 4 : 1 };
  const tabs = [];
  // API requests in flight, so waits end when the app's own work does.
  const inflight = new Set();
  const isApi = (request) =>
    new URL(request.url()).pathname.startsWith("/api/");
  const apiPaths = [];
  page.on("request", (request) => {
    if (!isApi(request)) return;
    inflight.add(request);
    apiPaths.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  for (const event of ["requestfinished", "requestfailed"])
    page.on(event, (request) => inflight.delete(request));
  try {
    // 1. Press feedback on a card body, a tab and the compose button.
    const targets = {
      card: rows.first(),
      tab: page.getByRole("tab", { name: /^Done/ }),
      compose: page.locator(".composer-launch").first(),
    };
    console.log("responsiveness: press");
    report.press = {};
    for (const [name, target] of Object.entries(targets)) {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        // A live Feed refresh can replace the element between aiming and
        // pressing; retry that sample rather than measure the wrong node.
        let sample = "no-pointerdown";
        for (
          let attempt = 0;
          attempt < 3 && sample === "no-pointerdown";
          attempt++
        )
          sample = await pressLatency(page, target);
        samples.push(sample);
      }
      if (samples.includes("no-pointerdown"))
        throw new Error(`Press target ${name} did not receive pointerdown`);
      report.press[name] = {
        visibleChange: samples.filter((value) => value !== null).length + "/5",
        ...summary(samples),
      };
    }

    console.log("responsiveness: tabs", JSON.stringify(report.press));
    // 2. Tab switches: cold first visit, then cached revisits.
    // One cold switch, then 21 cached ones: with 21 samples the p95 is not
    // just the single slowest switch, so one slow frame cannot decide it.
    for (let i = 0; i < 22; i++) {
      const name = i % 2 ? "Done" : "Working";
      tabs.push({ name, ...(await tabSwitch(page, name)) });
    }
    report.tabs = {
      cold: tabs[0],
      cached: summary(tabs.slice(1).map((entry) => entry.ms)),
      cachedShowedLoading: tabs.slice(1).filter((entry) => entry.sawLoading)
        .length,
    };
    await expect(rows.first()).toBeVisible();

    // A pressed style must not move the hit area. A press scale shrinks an
    // element away from points near its edge, so a click that starts there
    // ends on the parent and is lost. While held, and after any press
    // transition, a point half a pixel inside the edge must still hit the
    // element. (The compose button is a 54 px circle: a 3% scale moves its
    // edge by under a pixel.)
    report.pressHitArea = {};
    for (const [name, target] of [
      ["compose", targets.compose],
      ["card", targets.card],
    ]) {
      await target.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      const box = await target.boundingBox();
      const point = { x: box.x + 0.5, y: box.y + box.height / 2 };
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.waitForTimeout(200);
      const kept = await target.evaluate((element, { x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === element || element.contains(hit));
      }, point);
      // Release away from the target so no click or navigation follows.
      await page.mouse.move(2, 2);
      await page.mouse.up();
      await page.waitForTimeout(150);
      report.pressHitArea[name] = kept;
    }
    const menu = page.locator("dialog[open]");
    if (await menu.count()) {
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }

    if (client) {
      console.log("responsiveness: swipe", JSON.stringify(report.tabs));
      // Waits here, before the drags, so no idle wait sits right before a
      // measured gesture; the refresh below must finish in the same minute.
      const refreshMinute = await minuteWindow(page, inflight);
      // 3. A card swipe that does not cross the archive threshold.
      const card = page.locator(".feed-results .feed-item-card").first();
      await card.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      const box = await card.boundingBox();
      const y = box.y + Math.min(40, box.height / 2);
      const start = { x: box.x + box.width - 40, y };
      report.swipe = await dragProbe(
        page,
        client,
        start,
        { x: start.x - 60, y },
        36,
        600,
      );
      // Before release, the card must follow the finger: no commits is only
      // good if the card still moved.
      report.swipe.cardX = await card.evaluate(
        (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
      );
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(400);

      console.log("responsiveness: pull");
      // 4. Pull to refresh from the top of the Feed, then the refresh it starts.
      await page.evaluate(() => window.scrollTo(0, 0));
      const top = { x: 195, y: 240 };
      report.pull = await dragProbe(
        page,
        client,
        top,
        { x: 195, y: 420 },
        36,
        600,
      );
      // Before release, the indicator must be showing and ready.
      report.pull.indicator = await page.evaluate(() => {
        const element = document.querySelector(".pull-refresh");
        return element && !element.hidden
          ? {
              state: element.dataset.pull || element.className,
              label: element.getAttribute("aria-label"),
              y: new DOMMatrix(getComputedStyle(element).transform).m42,
            }
          : null;
      });
      const before = await page.evaluate(() => ({
        ...window.__loopCommitProbe,
      }));
      const requestsBefore = apiPaths.length;
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await settle(page, inflight);
      const after = await page.evaluate(() => ({
        ...window.__loopCommitProbe,
      }));
      await sameMinute(page, refreshMinute, "unchanged refresh");
      report.refresh = {
        // Refreshes the pull started, and the API reads that followed.
        started: after.refreshes - before.refreshes,
        requests: [...new Set(apiPaths.slice(requestsBefore))],
        commits: after.commits - before.commits,
        cardRenders: after.cardRenders - before.cardRenders,
        visibleCards: await page
          .locator(".feed-results .feed-item-card")
          .count(),
        // Every card wrapper in the page, including other Feed sections.
        cardWrappers: await page.locator(".feed-item-wrap").count(),
      };

      console.log("responsiveness: changed refresh");
      // A memoised card still re-renders when its content changes. Move one
      // Done result to another project through the conversation writer, pull
      // to refresh, and the card shows the new project while the unchanged
      // cards keep their render.
      const [changedResult] = await doneResults(page);
      if (!changedResult) throw new Error("No Done result to change");
      const changedCard = rowNamed(page, changedResult.title);
      await expect(changedCard).toHaveCount(1);
      const shownProject = await changedCard
        .locator(".card-project")
        .innerText();
      const otherProject = (await fixture.api("/bootstrap")).folders.find(
        (folder) => folder.name && !shownProject.includes(folder.name),
      );
      if (!otherProject) throw new Error("No other project to move it to");
      // Count from before the change: a background read may pick it up
      // before the pull finishes.
      const changeMinute = await minuteWindow(page, inflight);
      const beforeChange = await page.evaluate(() => ({
        ...window.__loopCommitProbe,
      }));
      conversations.setProject(
        fixture.db,
        otherProject.id,
        changedResult.conversation,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await dragProbe(page, client, top, { x: 195, y: 420 }, 36, 600);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await settle(page, inflight);
      const afterChange = await page.evaluate(() => ({
        ...window.__loopCommitProbe,
      }));
      await sameMinute(page, changeMinute, "changed refresh");
      await expect(changedCard.locator(".card-project")).toContainText(
        otherProject.name,
      );
      report.changedRefresh = {
        cardRenders: afterChange.cardRenders - beforeChange.cardRenders,
        cardWrappers: await page.locator(".feed-item-wrap").count(),
      };

      console.log("responsiveness: tab indicator");
      // The bar sits under the selected tab once it has slid there.
      await page.waitForTimeout(300);
      const barOffset = await page.evaluate(() => {
        const bar = document.querySelector(".feed-tab-indicator");
        const tab = document.querySelector(
          '.feed-tabs [role="tab"][aria-selected="true"]',
        );
        if (!bar || !tab || bar.hidden) return null;
        return (
          bar.getBoundingClientRect().left - tab.getBoundingClientRect().left
        );
      });
      if (barOffset === null || Math.abs(barOffset - 12) > 2)
        throw new Error(
          `The tab bar is not under the selected tab: ${barOffset}`,
        );
      report.tabIndicator = { offset: Math.round(barOffset) };

      console.log("responsiveness: sheet");
      // Sheets (D6): opening a result's reading sheet fades it in (the rule
      // applies; this does not prove a faded frame was drawn), and Close
      // closes it at once, leaving no open dialog.
      await page
        .locator(".feed-results .feed-item-card .feed-row")
        .first()
        .click();
      const sheet = page.locator("dialog.sheet[open]");
      await expect(sheet).toHaveCount(1);
      // The computed animation name, not getAnimations(): a finished
      // animation drops out of that list.
      const entering = await sheet.evaluate(
        (element) => getComputedStyle(element).animationName,
      );
      await page.waitForTimeout(300);
      const closeStarted = Date.now();
      await sheet
        .locator(":scope > .sheet-inner > .sheet-head")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      report.sheet = {
        enterAnimation: entering === "sheet-enter",
        closedMs: Date.now() - closeStarted,
      };

      console.log("responsiveness: writes");
      // 5. A local write with the server held for 800 ms: is the change
      // visible before the response? Archive the first Done result, which
      // sends PATCH /api/feed/:id; only that request is held. Both times are
      // taken in the browser: the frame the row disappears, and the
      // response's own timing. Read-state writes are measured by the change
      // that makes them local.
      const isArchive = (request) =>
        request.method() === "PATCH" &&
        /^\/api\/feed\/[^/]+$/.test(new URL(request.url()).pathname);
      // Swipe a Done card left past the threshold, which archives it.
      const swipeArchive = async (target) => {
        await target.evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        const cardBox = await target.boundingBox();
        const ay = cardBox.y + Math.min(40, cardBox.height / 2);
        const ax = Math.min(350, cardBox.x + cardBox.width - 30);
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: ax, y: ay, id: 1 }],
        });
        for (let step = 1; step <= 8; step++) {
          await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: ax - (170 * step) / 8, y: ay, id: 1 }],
          });
          await page.waitForTimeout(16);
        }
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      };
      const title = await page
        .locator(".feed-results .feed-item-card .feed-row")
        .first()
        .getAttribute("aria-label");
      const row = page
        .locator(".feed-results")
        .getByRole("button", { name: title, exact: true });

      // Refused (D5): the card leaves at once, comes back when the server
      // refuses, and the server's message replaces the Undo toast.
      const refusal = "This result changed. Refresh and try again.";
      const refuse = async (route) => {
        if (!isArchive(route.request())) return route.fallback();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: refusal }),
        });
      };
      await page.route("**/api/feed/*", refuse);
      try {
        await swipeArchive(
          page.locator(".feed-results .feed-item-card").first(),
        );
        await expect(row).toHaveCount(0, { timeout: 300 });
        await expect(row).toHaveCount(1, { timeout: 5000 });
        await expect(page.getByText(refusal)).toBeVisible();
      } finally {
        await page.unroute("**/api/feed/*", refuse);
      }
      report.archiveRefused = { restored: true, message: true };

      const hold = async (route) => {
        if (!isArchive(route.request())) return route.fallback();
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.continue();
      };
      await page.route("**/api/feed/*", hold);
      try {
        await page.evaluate((label) => {
          // Where each other card is on screen before the archive.
          const cardTop = (card) =>
            Math.round(card.getBoundingClientRect().top);
          const cardLabel = (card) =>
            card.querySelector(".feed-row")?.getAttribute("aria-label");
          const before = new Map(
            [...document.querySelectorAll(".feed-results .feed-item-wrap")].map(
              (card) => [cardLabel(card), cardTop(card)],
            ),
          );
          window.__loopArchive = new Promise((resolve) => {
            let released = null;
            // pointerup, not touchend: the card can leave the page during
            // pointerup, and a touchend on a removed card never reaches window.
            addEventListener(
              "pointerup",
              () => (released ??= performance.now()),
              { capture: true, once: true },
            );
            setTimeout(() => resolve(null), 10000);
            const check = () => {
              const present = [
                ...document.querySelectorAll(".feed-results .feed-row"),
              ].some((row) => row.getAttribute("aria-label") === label);
              if (!present && released !== null) {
                const gone = performance.now();
                // In that frame no other card has jumped (D6): each is
                // where it was, sliding from there or kept in place by
                // the browser's scroll anchoring.
                const jumped = [
                  ...document.querySelectorAll(".feed-results .feed-item-wrap"),
                ].filter(
                  (card) =>
                    before.has(cardLabel(card)) &&
                    Math.abs(before.get(cardLabel(card)) - cardTop(card)) > 1,
                ).length;
                return resolve({
                  visibleMs: gone - released,
                  goneAt: performance.timeOrigin + gone,
                  jumped,
                });
              }
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
        }, title);
        // Stamp arrival as it happens, in case the timing is unavailable.
        const response = page
          .waitForResponse((candidate) => isArchive(candidate.request()), {
            timeout: 10000,
          })
          .then((answer) => ({ answer, receivedAt: Date.now() }));
        // Handled now, so a timeout on a run that is already failing cannot
        // end the process before the cleanup below runs.
        response.catch(() => {});
        await swipeArchive(
          page.locator(".feed-results .feed-item-card").first(),
        );
        const shown = await page.evaluate(() => window.__loopArchive);
        const { answer, receivedAt } = await response;
        const timing = answer.request().timing();
        // Playwright reports -1 when a phase was not recorded.
        const respondedAt =
          timing.responseStart >= 0
            ? timing.startTime + timing.responseStart
            : receivedAt;
        report.archive = shown && {
          visibleMs: Math.round(shown.visibleMs),
          beforeResponse: shown.goneAt < respondedAt,
          cardsJumped: shown.jumped,
        };
      } finally {
        await page.unroute("**/api/feed/*", hold);
      }

      // Undo waits for the archive it reverses, then brings the card back.
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(row).toHaveCount(1, { timeout: 5000 });
      report.archiveUndone = true;

      // Uncertain (D5): with no answer the card stays archived here and the
      // owner is told it was not saved. Only their Retry resends the write.
      let attempts = 0;
      const drop = async (route) => {
        if (!isArchive(route.request())) return route.fallback();
        attempts++;
        await route.abort("failed");
      };
      await page.route("**/api/feed/*", drop);
      try {
        // Without Retry, the card comes back when the notice ends: the
        // server may not have archived it.
        await swipeArchive(
          page.locator(".feed-results .feed-item-card").first(),
        );
        await expect(row).toHaveCount(0, { timeout: 300 });
        const notSaved = page.getByText("Archive not confirmed.");
        await expect(notSaved).toBeVisible();
        await expect(notSaved).toHaveCount(0, { timeout: 8000 });
        await expect(row).toHaveCount(1);
        attempts = 0;

        // With the notice still up, a refresh still returns the card (the
        // server never archived it), but the change kept here keeps it
        // hidden until Retry.
        await swipeArchive(
          page.locator(".feed-results .feed-item-card").first(),
        );
        await expect(row).toHaveCount(0, { timeout: 300 });
        await expect(notSaved).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        const read = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/feed" &&
            response.request().method() === "GET",
          { timeout: 10000 },
        );
        await dragProbe(page, client, top, { x: 195, y: 420 }, 12, 200);
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await read;
        await page.waitForTimeout(200);
        await expect(row).toHaveCount(0);
        if (attempts !== 1)
          throw new Error(
            `An uncertain archive was resent ${attempts - 1} times without Retry`,
          );
      } finally {
        await page.unroute("**/api/feed/*", drop);
      }
      const retried = page.waitForResponse(
        (candidate) => isArchive(candidate.request()) && candidate.ok(),
        { timeout: 10000 },
      );
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await retried;
      await expect(row).toHaveCount(0);
      report.archiveUncertain = {
        restoredWhenNoticeEnds: true,
        keptRemovedThroughRefresh: true,
        resentOnlyOnRetry: true,
      };

      console.log("responsiveness: swipe to reply");
      // 6. Swipe an agent message right in a conversation. The message and
      // its reply hint follow the finger, the hint arms past the threshold,
      // and release starts a reply. The open thread renders on its own while
      // it updates, so commits here are reported, not budgeted; the Done card
      // swipe above budgets the same hook.
      await page.goto(
        fixture.base + "/?conversation=" + fixture.conversations[0].id,
        { waitUntil: "networkidle" },
      );
      const message = page
        .locator("dialog[open] article.message.assistant")
        .last();
      // A long message can be taller than the screen: touch a visible point
      // on the message itself, not a link, control or code block in it.
      const from = await message.evaluate((element) => {
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        const x = rect.left + 30;
        for (
          let y = Math.max(rect.top, 0) + 20;
          y < Math.min(rect.bottom, innerHeight) - 10;
          y += 20
        ) {
          const hit = document.elementFromPoint(x, y);
          if (
            hit &&
            element.contains(hit) &&
            !hit.closest("a,button,summary,input,textarea,pre,.table-scroll")
          )
            return { x, y };
        }
        return null;
      });
      if (!from) throw new Error("No plain point on the message to swipe");
      report.swipeReply = await dragProbe(
        page,
        client,
        from,
        { x: from.x + 100, y: from.y },
        20,
        400,
      );
      Object.assign(
        report.swipeReply,
        await message.evaluate((element) => ({
          armed: element.dataset.armed ?? null,
          x: new DOMMatrix(getComputedStyle(element).transform).m41,
          hint:
            getComputedStyle(element.querySelector(".swipe-reply-hint"))
              .display !== "none",
        })),
      );
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(
        page.locator("dialog[open] .composer textarea"),
      ).toBeFocused();

      console.log("responsiveness: draft");
      // A memoised card still shows a draft saved elsewhere: Feed reads
      // drafts and passes them to the card. Type in this thread's composer to
      // learn the draft key, save a draft for a Done card's thread under the
      // same owner and source, then refresh the Feed.
      await page.keyboard.type("Keep this for later");
      const draftKey = await expect
        .poll(
          () =>
            page.evaluate(() =>
              Object.keys(localStorage).find((key) =>
                /^loop-draft-text:[^:]*:\[/.test(key),
              ),
            ),
          { timeout: 5000 },
        )
        .toBeTruthy()
        .then(() =>
          page.evaluate(() =>
            Object.keys(localStorage).find((key) =>
              /^loop-draft-text:[^:]*:\[/.test(key),
            ),
          ),
        );
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      const [draftedResult] = await doneResults(page);
      if (!draftedResult) throw new Error("No Done result to draft a reply to");
      const drafted = rowNamed(page, draftedResult.title);
      await expect(drafted).toHaveCount(1);
      const draftedConversation = { id: draftedResult.conversation };
      // Key: loop-draft-text:<owner>:<JSON [source, conversation id]>.
      const [, owner, threadId] = draftKey.match(
        /^loop-draft-text:([^:]*):(.*)$/,
      );
      const [draftSource] = JSON.parse(threadId);
      const draftStorageKey = `loop-draft-text:${owner}:${JSON.stringify([draftSource, draftedConversation.id])}`;
      await page.evaluate(
        ([key, text]) => localStorage.setItem(key, text),
        [draftStorageKey, "Unsent reply from another view"],
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await dragProbe(page, client, top, { x: 195, y: 420 }, 36, 600);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(drafted).toContainText("Unsent reply from another view", {
        timeout: 10000,
      });
      report.draft = { shown: true };

      console.log("responsiveness: activity line");
      // A working card shows its run's latest activity in the harness's own
      // words (B1): seed one running tool step and open the Working tab.
      // A card whose run state shows a line (WORKING_RUN_DISPLAY_STATES).
      const working = await page.evaluate(async (states) => {
        const body = await (await fetch("/api/feed?filter=working")).json();
        const item = (body.items || body).find(
          (entry) => entry.run && states.includes(entry.run.state),
        );
        return (
          item && {
            conversation: item.conversation_id,
            run: item.run.id,
            title: item.title,
          }
        );
      }, WORKING_RUN_DISPLAY_STATES);
      if (!working) throw new Error("No working card with a running run");
      const step = {
        v: 1,
        kind: "tool",
        id: "responsiveness-step",
        source: { transport: "native", harness: "fixture", origin: "smoke" },
        revision: 1,
        fieldSeq: {},
        partial: false,
        replayed: false,
        data: {
          title: "Run npm test",
          category: "execute",
          status: "running",
          content: [],
          locations: ["/repo/package.json"],
          links: {},
        },
      };
      const now = Date.now();
      activities.upsert(
        fixture.db,
        fixture.owner,
        working.conversation,
        activityRecordKey(step, working.run),
        working.conversation,
        working.run,
        "tool",
        JSON.stringify(step),
        activities.maxSequence(fixture.db, fixture.owner).n + 1,
        now,
        now,
      );
      // The card reads only its line; it never downloads the activity list.
      const activityReads = [];
      const watchActivity = (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path.startsWith(`/api/conversations/${working.conversation}/activit`)
        )
          activityReads.push(path.split("/").at(-1));
      };
      page.on("request", watchActivity);
      await page.getByRole("tab", { name: /^Working/ }).click();
      const line = rowNamed(page, working.title).locator(".feed-activity-line");
      await expect(line).toHaveText("Run npm test");
      await expect(line).toHaveClass(/live/);
      await page.getByRole("tab", { name: /^Done/ }).click();
      await expect(
        page.locator(".feed-results .feed-activity-line"),
      ).toHaveCount(0);
      page.off("request", watchActivity);
      if (!activityReads.includes("activity-line"))
        throw new Error("Activity line was not read from its route");
      if (activityReads.includes("activities"))
        throw new Error("The card downloaded the full activity list");
      report.activityLine = { shown: true, live: true, lineRouteOnly: true };

      console.log("responsiveness: inline reply");
      // B2: reply on a Done card without leaving the feed. The message shows
      // at once, marked as sending, before Loop answers (D2); an unconfirmed
      // send is offered as Retry with the same idempotency key and is never
      // sent again on its own; a refusal gives the text back.
      const isSubmit = (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/runs";
      // A card with a draft keeps the full composer; clear the draft above.
      await page.evaluate(
        (key) => localStorage.removeItem(key),
        draftStorageKey,
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("tab", { name: /^Done/ }).click();
      await page.locator(".feed-results .feed-item-card").first().waitFor();
      const doneCard = page
        .locator(".feed-results .feed-item-card")
        .filter({
          has: page.getByRole("button", { name: "Reply", exact: true }),
        })
        .first();
      await doneCard
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      const replyBox = doneCard.locator(".inline-reply textarea");
      await expect(replyBox).toBeFocused();
      if (new URL(page.url()).searchParams.has("conversation"))
        throw new Error("Reply left the feed");
      const echo = doneCard.locator(".inline-reply-echo");
      const sendBox = (text) =>
        replyBox
          .fill(text)
          .then(() =>
            doneCard.getByRole("button", { name: "Send reply" }).click(),
          );

      // Closing the box keeps unsent text as the thread's draft.
      await replyBox.fill("Draft kept from the card");
      await doneCard.getByRole("button", { name: "Close reply" }).click();
      const keptDraft = page.locator(".feed-results .feed-draft", {
        hasText: "Draft kept from the card",
      });
      await expect(keptDraft).toHaveCount(1);
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("loop-draft-text:")) localStorage.removeItem(key);
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("tab", { name: /^Done/ }).click();
      await doneCard
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await expect(replyBox).toBeFocused();

      // Refused: nothing was accepted, so the text returns to the box.
      const refusedText = "Please also check the changelog";
      const refuseSubmit = async (route) => {
        if (!isSubmit(route.request())) return route.fallback();
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "This agent is not available." }),
        });
      };
      await page.route("**/api/runs", refuseSubmit);
      try {
        await sendBox(refusedText);
        await expect(
          doneCard.getByText("This agent is not available."),
        ).toBeVisible();
        await expect(replyBox).toHaveValue(refusedText);
        await expect(echo).toHaveCount(0);
      } finally {
        await page.unroute("**/api/runs", refuseSubmit);
      }

      // Uncertain: no answer. One request, then only Retry sends again, with
      // the same key.
      const uncertainText = "Thanks, ship it";
      const keys = [];
      const dropSubmit = async (route) => {
        if (!isSubmit(route.request())) return route.fallback();
        keys.push(route.request().postDataJSON().idempotencyKey);
        await route.abort("failed");
      };
      await page.route("**/api/runs", dropSubmit);
      try {
        await sendBox(uncertainText);
        await expect(echo).toHaveAttribute("data-state", "uncertain");
        await expect(echo).toContainText(uncertainText);
        await page.waitForTimeout(1500);
        if (keys.length !== 1)
          throw new Error(
            `An unconfirmed reply was sent ${keys.length} times without Retry`,
          );
      } finally {
        await page.unroute("**/api/runs", dropSubmit);
      }

      // The unconfirmed text, opened in the thread's composer, is sent with
      // the same key: the card and the composer agree on its signature.
      await doneCard.getByRole("button", { name: "Open full thread" }).click();
      const composer = page.locator("#composer");
      await expect(composer).toHaveValue(uncertainText);
      const composerKeys = [];
      const dropComposer = async (route) => {
        if (!isSubmit(route.request())) return route.fallback();
        composerKeys.push(route.request().postDataJSON().idempotencyKey);
        await route.abort("failed");
      };
      await page.route("**/api/runs", dropComposer);
      try {
        await page.getByRole("button", { name: "Send reply" }).click();
        await expect.poll(() => composerKeys.length).toBe(1);
      } finally {
        await page.unroute("**/api/runs", dropComposer);
      }
      if (composerKeys[0] !== keys[0])
        throw new Error(
          "The composer sent the card's unconfirmed reply with a new key",
        );
      // Back on the feed with no draft, the card's same text is still
      // unconfirmed: sending it again repeats the key, and then Retry does.
      // Leave the thread first: its composer saves its draft as it goes.
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("loop-draft-text:")) localStorage.removeItem(key);
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("tab", { name: /^Done/ }).click();
      await doneCard
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await expect(replyBox).toBeFocused();
      await page.route("**/api/runs", dropSubmit);
      try {
        await sendBox(uncertainText);
        await expect(echo).toHaveAttribute("data-state", "uncertain");
      } finally {
        await page.unroute("**/api/runs", dropSubmit);
      }
      if (keys.length !== 2 || keys[1] !== keys[0])
        throw new Error("Sending the unconfirmed text again used a new key");

      // Retry, held so the echo is seen before Loop answers.
      const retryKeys = [];
      const holdSubmit = async (route) => {
        if (!isSubmit(route.request())) return route.fallback();
        retryKeys.push(route.request().postDataJSON().idempotencyKey);
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.continue();
      };
      await page.route("**/api/runs", holdSubmit);
      let echoMs;
      try {
        const clicked = await page.evaluate(() => {
          // Resolves with the time from the click to the sending echo, and
          // whether the echo then showed as sent: once accepted, the thread
          // is working, so its Done card may leave the list right after.
          window.__loopEcho = new Promise((resolve) => {
            let pressed = null,
              sendingMs = null;
            addEventListener("click", () => (pressed ??= performance.now()), {
              capture: true,
              once: true,
            });
            setTimeout(() => resolve({ sendingMs, sent: false }), 10000);
            const check = () => {
              const state = document
                .querySelector(".inline-reply-echo")
                ?.getAttribute("data-state");
              if (pressed !== null && sendingMs === null && state === "sending")
                sendingMs = performance.now() - pressed;
              if (state === "sent") return resolve({ sendingMs, sent: true });
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
          return true;
        });
        if (!clicked) throw new Error("Echo probe did not start");
        const answered = page.waitForResponse(
          (response) => isSubmit(response.request()),
          { timeout: 10000 },
        );
        await doneCard.getByRole("button", { name: "Retry" }).click();
        const response = await answered;
        if (!response.ok())
          throw new Error(`Retried reply failed: ${response.status()}`);
        const seen = await page.evaluate(() => window.__loopEcho);
        if (!seen.sent)
          throw new Error("The accepted reply never showed as sent");
        echoMs = seen.sendingMs;
      } finally {
        await page.unroute("**/api/runs", holdSubmit);
      }
      if (retryKeys.length !== 1 || retryKeys[0] !== keys[0])
        throw new Error("Retry did not repeat the first request's key");
      if (echoMs == null) throw new Error("The sending echo never showed");
      report.inlineReply = {
        echoMs: Math.round(echoMs),
        closeKeptDraft: true,
        composerSameKey: true,
        refusedKeptText: true,
        uncertainSentOnce: true,
        retrySameKey: true,
      };
    }
  } finally {
    await client?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
  console.log(`responsiveness ${engine}: ${JSON.stringify(report)}`);
  // Every measurement must have produced a value; budgets are checked last,
  // so a missed budget does not hide a measurement that failed to run.
  const ran = (ok, name) => {
    if (!ok) throw new Error(`Responsiveness measurement did not run: ${name}`);
  };
  // Press samples are checked as they are taken (no pointerdown throws).
  ran(
    tabs.every((entry) => Number.isFinite(entry.ms)),
    `tab switches ${JSON.stringify(tabs)}`,
  );
  ran(report.swipe?.frames > 0, "swipe");
  ran(report.pull?.frames > 0, "pull");
  ran(
    report.refresh?.started > 0 && report.refresh.requests.length > 0,
    "pull to refresh",
  );
  // A refresh always commits; zero means the commit probe never attached
  // (for example after a React upgrade), and every count would read zero.
  ran(report.refresh.commits > 0, "React commit probe");
  ran(Number.isFinite(report.archive?.visibleMs), "archive");
  // Budgets met so far (D3). Press: every press shows a pressed style, p95
  // under 50 ms.
  for (const [name, value] of Object.entries(report.press))
    if (value.visibleChange !== "5/5" || !(value.p95 < 50))
      throw new Error(
        `Press ${name} missed its budget (5/5 visible, p95 < 50 ms): ${JSON.stringify(value)}`,
      );
  // Drags (D7): no React commit per move, and at most 5 % of frames
  // dropped. A drag sends 36 moves; up to 2 commits allows unrelated
  // background work in the window, while a render per move gives ~36.
  const reply = report.swipeReply;
  if (reply?.armed !== "right" || !(reply.x >= 72) || !reply.hint)
    throw new Error(
      `Swipe to reply did not follow the finger: ${JSON.stringify(reply)}`,
    );
  if (!(report.swipe.cardX <= -40))
    throw new Error(
      `The swiped card did not follow the finger: ${JSON.stringify(report.swipe)}`,
    );
  if (report.pull.indicator?.state !== "ready")
    throw new Error(
      `The pull indicator was not shown as ready: ${JSON.stringify(report.pull)}`,
    );
  for (const name of ["swipe", "pull"]) {
    const drag = report[name];
    if (drag.commits > 2 || drag.dropped > drag.frames * 0.05)
      throw new Error(
        `The ${name} drag missed its budget (<= 2 commits over 36 moves, <= 5 % dropped frames): ${JSON.stringify(drag)}`,
      );
  }
  // Feed updates (D8): an unchanged refresh re-renders no card, and switching
  // to a cached tab shows it within 100 ms (p95) with no loading placeholder.
  const changed = report.changedRefresh;
  if (!(changed.cardRenders >= 1 && changed.cardRenders < changed.cardWrappers))
    throw new Error(
      `A refresh with one changed card should re-render it and not every card: ${JSON.stringify(changed)}`,
    );
  if (report.refresh.cardRenders !== 0)
    throw new Error(
      `An unchanged refresh re-rendered cards: ${JSON.stringify(report.refresh)}`,
    );
  if (!(report.tabs.cached?.p95 < 100) || report.tabs.cachedShowedLoading)
    throw new Error(
      `A cached tab switch missed its budget (p95 < 100 ms, no placeholder): ${JSON.stringify(report.tabs)}`,
    );
  // Local writes (D5): an archived card leaves before the server answers.
  if (report.archive?.cardsJumped)
    throw new Error(
      `Cards jumped when one was archived: ${JSON.stringify(report.archive)}`,
    );
  if (!report.archive?.beforeResponse)
    throw new Error(
      `The archived card waited for the server: ${JSON.stringify(report.archive)}`,
    );
  // Sheets (D6): the reading sheet animates in and closes fully.
  if (!report.sheet?.enterAnimation)
    throw new Error(
      `The sheet did not animate in: ${JSON.stringify(report.sheet)}`,
    );
  // Sending (B2 D2): your reply shows within 100 ms of Send, before Loop
  // answers (the answer is held 800 ms).
  ran(Number.isFinite(report.inlineReply?.echoMs), "inline reply");
  if (!(report.inlineReply.echoMs < 100))
    throw new Error(
      `The reply echo missed its budget (< 100 ms): ${JSON.stringify(report.inlineReply)}`,
    );
  for (const [name, kept] of Object.entries(report.pressHitArea))
    if (!kept)
      throw new Error(
        `Pressing ${name} moved its hit area off a point near its edge`,
      );
  return report;
}
