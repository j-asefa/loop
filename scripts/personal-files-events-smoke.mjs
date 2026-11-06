import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { temporaryPageRoute } from "./helpers/temporary-page-route.mjs";

function publish(fixture, first, last) {
  const { db, owner } = fixture;
  db.transaction(() => {
    for (let n = first; n <= last; n++) {
      const id = "file-" + n;
      const name = "report-" + String(n).padStart(3, "0") + ".pdf";
      db.prepare(
        "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,kind,title,content,metadata,created_at,updated_at) VALUES(?,?,'agent','thread','run','file',?,'',?,1,1)",
      ).run(id, owner, name, JSON.stringify({ name }));
      db.prepare(
        "INSERT INTO artifact_objects VALUES(?,?,'run',?,?,'application/pdf',1,'fixture')",
      ).run(id, owner, id, id);
    }
    db.prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'run','artifact.published','{}',?)",
    ).run(owner, Date.now());
  }).immediate();
}

for (const engine of process.env.LOOP_BROWSER
  ? [process.env.LOOP_BROWSER]
  : ["chromium", "webkit"]) {
  const browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(engine === "chromium"
      ? {
          args: ["--no-sandbox"],
          executablePath: process.env.CHROMIUM_PATH || undefined,
        }
      : {}),
  });
  try {
    {
      const fixture = await cardsFixture(true, { projectedWrites: true });
      let context;
      try {
        const { db, owner } = fixture;
        db.prepare(
          "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('agent',?,'Files','files','openai','fixture',1)",
        ).run(owner);
        db.prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('thread',?,'agent','Files',1)",
        ).run(owner);
        db.prepare(
          "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES('run',?,'agent','thread','Files','running','files',1,1)",
        ).run(owner);
        publish(fixture, 1, 120);
        context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          serviceWorkers: "block",
        });
        if (fixture.browser.cookie) {
          const [name, value] = fixture.browser.cookie.split("=");
          await context.addCookies([
            {
              name,
              value,
              url: fixture.origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
        }
        await context.route(/\/api\/events\?/, (route) => route.abort());
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let reads = 0;
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/api/me/files") reads++;
        });
        await page.goto(fixture.origin + "/?page=profile&profileTab=files");
        const rows = page.locator(".personal-files-list article");
        const more = page.getByRole("button", {
          name: "Load more files",
          exact: true,
        });
        await expect(rows).toHaveCount(40);
        // A refresh between pointer press and release must not replace the
        // button or discard the requested append. Hold that refresh so the
        // click also exercises queueing behind an in-flight read.
        let refreshHeld = false,
          releaseRefresh;
        const refreshGate = new Promise((resolve) => {
          releaseRefresh = resolve;
        });
        const stopRefresh = await temporaryPageRoute(
          page,
          "**/api/me/files?*",
          async (route) => {
            if (
              refreshHeld ||
              new URL(route.request().url()).searchParams.has("before")
            )
              return route.fallback();
            const response = await route.fetch();
            refreshHeld = true;
            await refreshGate;
            await route.fulfill({ response });
          },
        );
        await more.evaluate((button) =>
          button.addEventListener(
            "pointerdown",
            () => window.dispatchEvent(new Event("loop-refresh")),
            { once: true },
          ),
        );
        try {
          await more.click({ delay: 150 });
          await expect.poll(() => refreshHeld).toBe(true);
          await expect(rows).toHaveCount(40);
        } finally {
          releaseRefresh();
          await stopRefresh();
        }
        await expect(rows).toHaveCount(80);
        await rows.nth(60).scrollIntoViewIfNeeded();
        const scroll = await page.evaluate(() => {
          const list = document.querySelector(".personal-files-list");
          window.__minimumFiles = list.children.length;
          new MutationObserver(() => {
            window.__minimumFiles = Math.min(
              window.__minimumFiles,
              list.children.length,
            );
          }).observe(list, { childList: true });
          return scrollY;
        });
        const before = reads;
        db.prepare(
          "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'run','delta','{}',?)",
        ).run(owner, Date.now());
        await expect
          .poll(() => reads, { timeout: 10000 })
          .toBeGreaterThan(before);
        await expect(
          page.getByText("Loading files…", { exact: true }),
        ).toHaveCount(0);
        await expect(rows).toHaveCount(80);
        assert.equal(
          await page.evaluate(() => window.__minimumFiles),
          80,
          "refresh must not clear loaded rows",
        );
        assert.ok(
          Math.abs((await page.evaluate(() => scrollY)) - scroll) < 2,
          "an unchanged refresh preserves scroll",
        );

        const sourceReads = reads;
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: ["unrelated-source"] },
            }),
          ),
        );
        await page.waitForTimeout(300);
        assert.equal(
          reads,
          sourceReads,
          "another source must not refresh this Files library",
        );

        let held = false,
          release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        await page.route("**/api/me/files?*", async (route) => {
          if (
            held ||
            !new URL(route.request().url()).searchParams.has("before")
          )
            return route.continue();
          const response = await route.fetch();
          held = true;
          await gate;
          await route.fulfill({ response });
        });
        try {
          await more.click();
          await expect.poll(() => held).toBe(true);
          publish(fixture, 121, 245);
          // The queued socket notification must not cancel this append.
          await page.waitForTimeout(2200);
        } finally {
          release();
          await page.unrouteAll({ behavior: "wait" });
        }
        await expect(rows).toHaveCount(245, { timeout: 20000 });
        await expect(
          page.getByRole("button", {
            name: "Preview report-001.pdf",
            exact: true,
          }),
        ).toHaveCount(1);
        await expect(more).toHaveCount(0);
        assert.equal(
          new Set(
            await rows.locator(".published-file strong").allTextContents(),
          ).size,
          245,
          "catch-up must include every file exactly once",
        );
        assert.equal(await page.evaluate(() => window.__minimumFiles), 80);

        // A failed refresh retains all loaded files; retry and a filter change
        // fence an older response from replacing the newly selected query.
        await page.route("**/api/me/files?*", (route) =>
          route.fulfill({
            status: 503,
            json: { error: "Fixture unavailable" },
          }),
        );
        await page.evaluate(() =>
          window.dispatchEvent(new Event("loop-refresh")),
        );
        await expect(page.locator(".personal-files [role=alert]")).toBeVisible({
          timeout: 20000,
        });
        await expect(rows).toHaveCount(245);
        await page.unrouteAll({ behavior: "wait" });
        let retryHeld = false,
          releaseRetry;
        const retryGate = new Promise((resolve) => {
          releaseRetry = resolve;
        });
        await page.route("**/api/me/files?*", async (route) => {
          if (retryHeld) return route.continue();
          const response = await route.fetch();
          retryHeld = true;
          await retryGate;
          await route.fulfill({ response });
        });
        try {
          await page
            .getByRole("button", { name: "Retry", exact: true })
            .click();
          await expect.poll(() => retryHeld).toBe(true);
          await page
            .getByRole("searchbox", { name: "Search files" })
            .fill("report-001");
          await expect(rows).toHaveCount(1);
        } finally {
          releaseRetry();
          await page.unrouteAll({ behavior: "wait" });
        }
        await expect(rows).toHaveCount(1);
        await expect(
          page.getByRole("button", {
            name: "Preview report-001.pdf",
            exact: true,
          }),
        ).toHaveCount(1);
        assert.deepEqual(errors, []);
        // Both quiet active runs and completed runs recover without a later
        // notification, including a proxy's non-JSON failure.
        db.prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES('file-answer',?,'thread','run','assistant','Files are ready',?)",
        ).run(owner, Date.now());
        for (const state of ["running", "completed"]) {
          db.prepare("UPDATE runs SET state=? WHERE id='run'").run(state);
          const thread = await context.newPage();
          await thread.addInitScript(() => {
            window.__filesLastNotification = Date.now();
            for (const name of [
              "loop-workspace-frame",
              "loop-workspace-change",
            ])
              window.addEventListener(name, () => {
                window.__filesLastNotification = Date.now();
              });
          });
          const pendingRunReads = new Set();
          let lastRunRead = Date.now();
          thread.on("request", (request) => {
            if (new URL(request.url()).pathname !== "/api/runs/run/files")
              return;
            pendingRunReads.add(request);
            lastRunRead = Date.now();
          });
          const finishRunRead = (request) => {
            if (pendingRunReads.delete(request)) lastRunRead = Date.now();
          };
          thread.on("requestfinished", finishRunRead);
          thread.on("requestfailed", finishRunRead);
          let runReads = 0,
            injectFailure = false;
          await thread.route("**/api/runs/run/files", (route) =>
            injectFailure && ++runReads === 1
              ? route.fulfill({
                  status: 503,
                  contentType: "text/html",
                  body: "<html>Temporary gateway failure</html>",
                })
              : route.continue(),
          );
          await thread.goto(fixture.origin);
          await expect(thread.locator(".workspace-connection")).toHaveText(
            "Connected to workspace",
          );
          await thread.evaluate(() => {
            const url = new URL(location.href);
            url.search = "?conversation=thread";
            navigator.serviceWorker.dispatchEvent(
              new MessageEvent("message", {
                data: { type: "loop-open", url: url.href },
              }),
            );
          });
          await expect(
            thread
              .locator(".conversation-sheet")
              .getByText("Files are ready", { exact: true }),
          ).toBeVisible();
          await expect(
            thread
              .locator(".conversation-sheet .published-files")
              .getByRole("button", {
                name: "Preview report-001.pdf",
                exact: true,
              }),
          ).toBeVisible({ timeout: 8000 });
          // Opening detail changes a multiplex subscription and announces the
          // source again. Let that bounded 3s coalescing window and its reads
          // settle before injecting a failure into an otherwise quiet stream.
          await expect
            .poll(
              async () =>
                pendingRunReads.size === 0 &&
                Date.now() - lastRunRead >= 3500 &&
                (await thread.evaluate(
                  () => Date.now() - window.__filesLastNotification >= 3500,
                )),
              { timeout: 10000 },
            )
            .toBe(true);
          injectFailure = true;
          await thread.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("loop-workspace-change", {
                detail: {
                  sources: [""],
                  changes: [
                    {
                      source: "",
                      events: [
                        {
                          type: "invalidate",
                          scope: { kind: "collection", id: "results" },
                        },
                      ],
                    },
                  ],
                },
              }),
            ),
          );
          const readError = thread.locator(
            ".conversation-sheet .published-files [role=alert]",
          );
          await expect(readError).toBeVisible();
          await expect(readError).toHaveCount(0, { timeout: 8000 });
          await expect(
            thread
              .locator(".conversation-sheet .published-files")
              .getByRole("button", {
                name: "Preview report-001.pdf",
                exact: true,
              }),
          ).toBeVisible();
          assert.equal(
            runReads,
            2,
            "One quiet run read failure must recover with one bounded retry",
          );
          await thread.close();
        }
        console.log(
          `PASS ${engine}/companion: Files keeps loaded pages and scroll, queues updates during append, catches up 125 new files, isolates source/filter changes and retains history on failure`,
        );
      } finally {
        await context?.close();
        await fixture.close();
      }
    }
  } finally {
    await browser.close();
  }
}
