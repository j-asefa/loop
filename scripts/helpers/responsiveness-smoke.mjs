import { expect } from "@playwright/test";

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
  const firstHost = (fiber) => {
    for (let node = fiber.child; node; node = node.child)
      if (node.tag === 5) return node.stateNode;
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
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === element || element.contains(hit))) return { x, y };
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
  // A release that came too late lets the long press open the card menu,
  // which would put every later step on a modal page.
  if (await page.locator("dialog[open]").count()) {
    await page.keyboard.press("Escape");
    throw new Error("The held press opened a dialog before it was released");
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
async function dragProbe(page, client, from, to, steps, durationMs) {
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
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
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
    for (const name of [
      "Working",
      "Done",
      "Working",
      "Done",
      "Working",
      "Done",
    ])
      tabs.push({ name, ...(await tabSwitch(page, name)) });
    report.tabs = {
      cold: tabs[0],
      cached: summary(tabs.slice(1).map((entry) => entry.ms)),
      cachedShowedLoading: tabs.slice(1).filter((entry) => entry.sawLoading)
        .length,
    };
    await expect(rows.first()).toBeVisible();

    if (client) {
      console.log("responsiveness: swipe", JSON.stringify(report.tabs));
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
      const title = await page
        .locator(".feed-results .feed-item-card .feed-row")
        .first()
        .getAttribute("aria-label");
      const hold = async (route) => {
        if (!isArchive(route.request())) return route.fallback();
        await new Promise((resolve) => setTimeout(resolve, 800));
        await route.continue();
      };
      await page.route("**/api/feed/*", hold);
      try {
        await page.evaluate((label) => {
          window.__loopArchive = new Promise((resolve) => {
            let released = null;
            addEventListener(
              "touchend",
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
                return resolve({
                  visibleMs: gone - released,
                  goneAt: performance.timeOrigin + gone,
                });
              }
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
        }, title);
        const response = page.waitForResponse(
          (candidate) => isArchive(candidate.request()),
          { timeout: 10000 },
        );
        const target = page.locator(".feed-results .feed-item-card").first();
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
        const shown = await page.evaluate(() => window.__loopArchive);
        const timing = (await response).request().timing();
        const respondedAt = timing.startTime + timing.responseStart;
        report.archive = shown && {
          visibleMs: Math.round(shown.visibleMs),
          beforeResponse: shown.goneAt < respondedAt,
        };
      } finally {
        await page.unroute("**/api/feed/*", hold);
      }
    }
  } finally {
    await client?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
  console.log(`responsiveness ${engine}: ${JSON.stringify(report)}`);
  // This smoke records a baseline. Each later change asserts its own budget;
  // here every measurement must have produced a value.
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
  ran(Number.isFinite(report.archive?.visibleMs), "archive");
  return report;
}
