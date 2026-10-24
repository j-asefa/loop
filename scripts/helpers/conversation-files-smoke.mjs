import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Exercise the real thread with slow file metadata and on-demand file bytes.
export async function conversationFilesSmoke(page, fixture, conversation) {
  await fixture.api(
    `/conversations/${conversation}/position`,
    { positionMessageId: null },
    "PUT",
  );
  const { messages } = await fixture.api(`/conversations/${conversation}`);
  const answers = messages.filter(
    (message) =>
      message.role === "assistant" && !JSON.parse(message.metadata).progress,
  );
  const latest = answers.at(-1),
    oldest = answers[0];
  assert(
    answers.length > 10,
    "Use a long transcript to catch eager file-list fanout",
  );
  const runs = new Set(answers.map((message) => message.run_id));
  const listReads = new Map(),
    downloads = [];
  let releaseLists,
    failFiles = true,
    releaseOlder;
  const listsGate = new Promise((resolve) => {
    releaseLists = resolve;
  });
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  let releaseReload,
    reloads = 0;
  const reloadGate = new Promise((resolve) => {
    releaseReload = resolve;
  });
  const transcriptPath = (url) =>
    url.pathname === `/api/conversations/${conversation}` &&
    url.searchParams.get("message") === latest.id;
  const holdReload = async (route) => {
    reloads++;
    await reloadGate;
    await route.continue();
  };
  const filesPath = (url) => /^\/api\/runs\/[^/]+\/files$/.test(url.pathname);
  const downloadPath = (url) =>
    /^\/api\/(artifacts\/[^/]+\/file|objects\/[^/]+)$/.test(url.pathname);
  const fileId = "conversation-file-fixture";
  const listRoute = async (route) => {
    const run = new URL(route.request().url()).pathname.split("/")[3];
    if (!runs.has(run)) return route.continue();
    listReads.set(run, (listReads.get(run) || 0) + 1);
    await listsGate;
    if (run === oldest.run_id) await olderGate;
    if (failFiles) {
      await route.fulfill({
        status: 503,
        json: { error: "File list temporarily unavailable" },
      });
      return;
    }
    await route
      .fulfill({
        json: Array.from({ length: 12 }, (_, index) => ({
          id: `${fileId}-${index}`,
          title: `Design ${index}`,
          metadata: JSON.stringify({
            name: `design-${index}.png`,
            mime: "image/png",
            size: 5_000_000,
          }),
        })),
      })
      .catch(() => {}); // A closed thread aborts its pending file read.
  };
  const downloadRoute = async (route) => {
    downloads.push(route.request().url());
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  };
  await page.route(filesPath, listRoute);
  await page.route(downloadPath, downloadRoute);
  try {
    await page.goto(`${fixture.base}/?conversation=${conversation}`);
    const transcript = page.locator(".conversation-sheet .messages");
    const answer = page.locator(`#message-${latest.id}`);
    await expect(answer).toBeInViewport();
    await expect(transcript).toHaveAttribute("aria-busy", "false");
    await expect(
      page.locator(".composer-dock.thread-mode textarea"),
    ).toBeEnabled();
    await expect.poll(() => listReads.get(latest.run_id)).toBe(1);
    // Empty/loading summaries must not insert temporary space into a thread.
    await expect(transcript.locator(".published-files")).toHaveCount(0);
    assert(
      listReads.size < runs.size / 2,
      "Opening must defer file lists for offscreen answers",
    );
    assert.equal(listReads.has(oldest.run_id), false);
    assert.equal(
      downloads.length,
      0,
      "Conversation text must not download any files",
    );

    // A slow request plus several refreshes still has only one read in flight.
    const latestReads = listReads.get(latest.run_id);
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++)
        window.dispatchEvent(new Event("loop-workspace-change"));
    });
    await page.waitForTimeout(100);
    assert.equal(listReads.get(latest.run_id), latestReads);
    releaseLists();
    await expect(answer.getByRole("alert")).toContainText(
      "File list temporarily unavailable",
    );
    await expect(transcript).toHaveAttribute("aria-busy", "false");
    await expect(answer).toContainText(latest.content);
    failFiles = false;
    await answer
      .getByRole("button", { name: "Retry files", exact: true })
      .click();
    await expect(
      answer.getByRole("button", { name: /^Preview design-/ }),
    ).toHaveCount(12);
    await expect(answer.getByRole("alert")).toHaveCount(0);
    await expect(answer.locator("img")).toHaveCount(0);
    assert.equal(
      downloads.length,
      0,
      "File names and sizes must render without downloading image previews",
    );

    // A link within this thread reloads the transcript. Retain file summaries
    // throughout that read, without issuing another request for each run.
    const beforeReload = listReads.get(latest.run_id);
    await page.route(transcriptPath, holdReload);
    await page.evaluate(
      ({ conversation, message }) => {
        const url = new URL(location.href);
        url.search = new URLSearchParams({ conversation, message }).toString();
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "loop-open", url: url.href },
          }),
        );
      },
      { conversation, message: latest.id },
    );
    await expect.poll(() => reloads).toBe(1);
    await expect(transcript).toHaveAttribute("aria-busy", "true");
    await expect(
      answer.getByRole("button", { name: /^Preview design-/ }),
    ).toHaveCount(12);
    releaseReload();
    await expect(transcript).toHaveAttribute("aria-busy", "false");
    await expect(
      answer.getByRole("button", { name: /^Preview design-/ }),
    ).toHaveCount(12);
    assert.equal(listReads.get(latest.run_id), beforeReload);
    await page.unroute(transcriptPath, holdReload);
    await answer
      .getByRole("button", { name: "Preview design-0.png", exact: true })
      .click();
    const preview = page.getByRole("dialog", {
      name: "design-0.png",
      exact: true,
    });
    await expect
      .poll(() =>
        preview
          .getByRole("img")
          .evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    assert.equal(
      downloads.length,
      1,
      "Opening one file must download only that file",
    );
    assert(downloads[0].endsWith(`/api/artifacts/${fileId}-0/file`));
    await preview.getByRole("button", { name: "Close", exact: true }).click();
    await expect(preview).toHaveCount(0);

    // Scrolling opts into older file metadata. Leaving cancels that slow read.
    assert.equal(listReads.has(oldest.run_id), false);
    const older = page.locator(`#message-${oldest.id}`);
    await older.scrollIntoViewIfNeeded();
    await expect(older).toBeInViewport();
    await expect.poll(() => listReads.get(oldest.run_id)).toBe(1);
    const aborted = page.waitForEvent(
      "requestfailed",
      (request) =>
        new URL(request.url()).pathname === `/api/runs/${oldest.run_id}/files`,
    );
    await page
      .locator("dialog.conversation-sheet[open] > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await aborted;
    releaseOlder();
    await expect(page.locator(".conversation-sheet[open]")).toHaveCount(0);
    assert.equal(downloads.length, 1);
  } catch (error) {
    console.error("Conversation files diagnostics", JSON.stringify({
      latest: { message: latest.id, run: latest.run_id },
      listReads: Object.fromEntries(listReads),
      answer: await page.locator(`#message-${latest.id}`).innerHTML().catch(() => "missing"),
    }));
    throw error;
  } finally {
    failFiles = false;
    releaseLists();
    releaseOlder();
    releaseReload();
    await page.unroute(filesPath, listRoute);
    await page.unroute(downloadPath, downloadRoute);
    await page.unroute(transcriptPath, holdReload);
  }
}
