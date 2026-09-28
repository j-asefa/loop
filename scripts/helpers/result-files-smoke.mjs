import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";

export async function resultFilesSmoke(page, fixture, capture) {
  const original = fixture.db
    .prepare("SELECT * FROM artifacts WHERE id=?")
    .get(fixture.artifacts[0]);
  const agent = fixture.db
    .prepare("SELECT * FROM agents WHERE id=?")
    .get(original.agent_id);
  const source =
    "| Feature | What ACP could let us surface | Difference from Loop today |\n| --- | --- | --- |\n| Live plans | A checklist with pending, active and completed steps that updates as the agent works. | Loop's native event model has no dedicated plan representation. |\n| Streaming updates | Readable intermediate messages and progress from the agent. | The final column stays readable while scrolling horizontally. |";
  const fileId = randomUUID(),
    callId = randomUUID();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    "base64",
  );
  const checksum = createHash("sha256").update(bytes).digest("base64");
  const key = `objects/${createHash("sha256").update(fixture.owner).digest("hex")}/${original.run_id}/${createHash("sha256").update(callId).digest("hex")}`;
  const dbPath = fixture.db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main").file;
  const filePath = join(dirname(dbPath), key);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  fixture.db
    .prepare(
      "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,'file',?,?,?,?)",
    )
    .run(
      fileId,
      fixture.owner,
      agent.id,
      original.conversation_id,
      original.run_id,
      "Design mockup",
      "File: mockup.png",
      JSON.stringify({
        uploaded: true,
        name: "mockup.png",
        mime: "image/png",
        size: bytes.length,
        model: agent.model,
      }),
      Date.now(),
      Date.now(),
    );
  fixture.db
    .prepare("INSERT INTO artifact_objects VALUES(?,?,?,?,?,?,?,?)")
    .run(
      fileId,
      fixture.owner,
      original.run_id,
      callId,
      key,
      "image/png",
      bytes.length,
      checksum,
    );
  fixture.db
    .prepare("UPDATE artifacts SET content=? WHERE id=?")
    .run(
      source +
        `\n\n[View mockup](/api/artifacts/${fileId}/file)` +
        `\n\n![Preview the mockups](/api/artifacts/${fileId}/file)`,
      original.id,
    );
  const dialog = () => page.locator("dialog[open]").last();
  try {
    for (const theme of ["light", "dark"]) {
      for (const width of [320, 390, 1024]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(fixture.base + "/?artifact=" + original.id);
        await expect(dialog().locator(".result-author-details")).toContainText(
          JSON.parse(original.metadata).model,
        );
        await expect(
          dialog().locator(".result-author-details"),
        ).not.toContainText(/ChatGPT|OpenAI/);
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        const table = dialog().getByRole("region", {
          name: "Table",
          exact: true,
        });
        await table.scrollIntoViewIfNeeded();
        const metrics = await table.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          width: el.clientWidth,
          first: el.querySelector("th").getBoundingClientRect().width,
        }));
        assert(
          metrics.first >= 150,
          "The first column must keep readable width",
        );
        if (width <= 390) {
          assert(
            metrics.scrollWidth > metrics.width,
            "Wide tables must overflow inside their scroll area",
          );
          await table.evaluate((el) => (el.scrollLeft = el.scrollWidth));
          assert(
            await table.evaluate((el) => el.scrollLeft > 0),
            "The final columns must be reachable horizontally",
          );
        }
        await capture(`scrollable-result-table-${theme}-${width}`);
        const image = dialog().getByRole("img", {
          name: "mockup.png",
          exact: true,
        });
        await image.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            image.evaluate((el) => el.complete && el.naturalWidth > 0),
          )
          .toBe(true);
        await capture(`published-file-${theme}-${width}`);
        const url = page.url();
        await dialog()
          .getByRole("button", {
            name: "Preview image mockup.png",
            exact: true,
          })
          .click();
        await expect(page.locator("dialog[open]")).toHaveCount(2);
        await expect(
          dialog().getByRole("heading", { name: "mockup.png", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await expect(
          dialog().getByRole("button", { name: "Close", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await expect
          .poll(() =>
            dialog()
              .getByRole("img", { name: "mockup.png", exact: true })
              .evaluate((el) => el.complete && el.naturalWidth > 0),
          )
          .toBe(true);
        assert.equal(
          page.url(),
          url,
          "Previewing a file must not navigate away from Loop",
        );
        await capture(`in-app-file-preview-${theme}-${width}`);
        await dialog()
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(page.locator("dialog[open]")).toHaveCount(1);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog()
      .getByRole("link", { name: "Preview the mockups", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(2);
    await expect(
      dialog().getByRole("heading", { name: "mockup.png", exact: true }),
    ).toBeVisible();
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    // The agent's Markdown download link was the original iOS escape path.
    const pagesBefore = page.context().pages().length;
    await dialog()
      .getByRole("link", { name: "View mockup", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(2);
    await expect(
      dialog().getByRole("heading", { name: "mockup.png", exact: true }),
    ).toBeVisible();
    assert.equal(page.context().pages().length, pagesBefore);
    // A normal workspace refresh must not remount Markdown links and dismiss
    // their open previews (or replace the table the user has scrolled).
    const tableBefore = await page
      .locator(".result-sheet .table-scroll")
      .elementHandle();
    const eventsUrl = /\/api\/events\?after=/;
    await page.route(eventsUrl, (route) =>
      route.fulfill({ json: [{ id: 999999999 }] }),
    );
    try {
      await (await page.waitForResponse(eventsUrl)).finished();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await expect(page.locator("dialog[open]")).toHaveCount(2);
      assert(
        await tableBefore.evaluate((el) => el.isConnected),
        "Workspace refreshes must preserve the existing table",
      );
    } finally {
      await page.unroute(eventsUrl);
    }
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    // Exercise the download fallback without bringing up a native OS dialog.
    await page.evaluate(() =>
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: () => false,
      }),
    );
    const resultUrl = page.url();
    const openPreview = async () => {
      await dialog()
        .getByRole("button", { name: "Preview mockup.png", exact: true })
        .click();
      await expect(page.locator("dialog[open]")).toHaveCount(2);
    };
    await openPreview();
    await expect(
      dialog().getByRole("link", { name: "Download", exact: true }),
    ).toHaveAttribute("target", "_blank");
    const downloading = page.waitForEvent("download");
    await dialog().getByRole("link", { name: "Download", exact: true }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "mockup.png");
    assert.deepEqual(readFileSync(await download.path()), bytes);
    assert.equal(page.url(), resultUrl);
    await expect(
      dialog().getByRole("button", { name: "Close", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(dialog().locator(".result-author-details")).toBeVisible();
    // A cancelled native share must leave both the file and reply accessible.
    await page.evaluate(() => {
      window.sharedFiles = [];
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: ({ files }) => files?.length === 1,
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async ({ files }) => {
          window.sharedFiles.push({
            name: files[0].name,
            type: files[0].type,
            bytes: Array.from(new Uint8Array(await files[0].arrayBuffer())),
          });
          throw new DOMException("Cancelled", "AbortError");
        },
      });
    });
    await openPreview();
    await dialog()
      .getByRole("button", { name: "Save or share", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.sharedFiles.length))
      .toBe(1);
    assert.deepEqual(await page.evaluate(() => window.sharedFiles[0]), {
      name: "mockup.png",
      type: "image/png",
      bytes: Array.from(bytes),
    });
    await expect(dialog().getByRole("alert")).toHaveCount(0);
    assert.equal(page.url(), resultUrl);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    const fileEndpoint = `**/api/artifacts/${fileId}/file`;
    await page.route(fileEndpoint, (route) =>
      route.fulfill({ status: 503, body: "Unavailable" }),
    );
    await openPreview();
    await expect(dialog().getByRole("alert")).toContainText(
      "Could not load this file",
    );
    await expect(
      dialog().getByRole("button", { name: "Close", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.unroute(fileEndpoint);
    await dialog()
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await expect(
      dialog().getByRole("img", { name: "mockup.png", exact: true }),
    ).toBeVisible();
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    const replyDraft = "Keep my reply while I preview the mockups";
    await page.evaluate(
      ({ id, draft }) => {
        sessionStorage.setItem("loop-result-reply-" + id, draft);
      },
      { id: original.id, draft: replyDraft },
    );
    await dialog().getByRole("button", { name: "Reply", exact: true }).click();
    const composer = page.locator(".composer");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(composer.getByLabel("Reply to agent")).toHaveValue(replyDraft);
    await composer.getByRole("link", { name: "Preview the mockups" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(
      dialog().getByRole("heading", { name: "mockup.png" }),
    ).toBeVisible();
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(composer.getByLabel("Reply to agent")).toHaveValue(replyDraft);
    const replyContext = await page.evaluate(() =>
      sessionStorage.getItem("loop-draft-context"),
    );
    await composer.getByRole("button", { name: "Collapse composer" }).click();
    const resultCard = page.locator(".feed-card").filter({
      has: page.getByRole("heading", { name: original.title, exact: true }),
    });
    await resultCard
      .getByRole("button", { name: "Open output", exact: true })
      .click();
    await dialog().getByLabel("Result options", { exact: true }).click();
    await dialog().getByRole("button", { name: "Source conversation" }).click();
    await expect(dialog().getByLabel("Reply to agent")).toHaveValue(replyDraft);
    await expect(
      dialog().getByRole("region", { name: "Original message" }),
    ).toContainText("Live plans");
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("loop-draft-context")),
      replyContext,
    );
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Compose a message" }).click();
    await composer.getByLabel("Reply to agent").fill("");
    await composer.getByRole("button", { name: "Clear reply context" }).click();
    await composer.getByRole("button", { name: "Collapse composer" }).click();
    await page.evaluate(
      (id) => sessionStorage.removeItem("loop-result-reply-" + id),
      original.id,
    );
    // Real feed entry points start below the fold. Closing the sheet must not
    // restore that old feed offset after navigating to the author's profile.
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page
      .locator(".feed-card")
      .filter({
        has: page.getByRole("heading", { name: original.title, exact: true }),
      })
      .getByRole("button", { name: "Open output", exact: true })
      .click();
    assert(
      await page.evaluate(() => scrollY > 80),
      "Regression needs a scrolled feed",
    );
    await dialog()
      .getByRole("button", { name: `Open @${agent.name} profile`, exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator(".profile-head h1")).toHaveText("@" + agent.name);
    await expect(page.locator(".profile-head h1")).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const fileCard = page
      .locator(".feed-card")
      .filter({ hasText: "Design mockup" });
    await expect(
      fileCard.getByRole("img", { name: "mockup.png", exact: true }),
    ).toBeVisible();
    await fileCard
      .getByRole("button", { name: "Open output", exact: true })
      .click();
    await expect(
      dialog().getByRole("button", { name: "Preview mockup.png", exact: true }),
    ).toBeVisible();
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Messages", exact: true }).click();
    await page
      .locator(".agent-message-actions")
      .first()
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(
      page
        .locator(".composer")
        .getByRole("textbox", { name: "Reply to agent" }),
    ).toBeVisible();
    await expect(
      page.locator(".composer").getByLabel("Agent recipient", { exact: true }),
    ).toHaveValue(agent.id);
    await expect(
      page.locator(".composer .composer-model-name"),
    ).not.toContainText(/ChatGPT|OpenAI/);
    await page
      .locator(".composer")
      .getByRole("button", { name: "Clear reply context" })
      .click();
    await page
      .locator(".composer")
      .getByRole("button", { name: "Collapse composer" })
      .click();
    // Finish profile reads before the next scenario switches fixture origins.
    // WebKit reports a cancelled message refresh as an access-control error
    // when that refresh overlaps the document navigation.
    await page.getByRole("button", { name: "Back to feed", exact: true }).click();
    await expect(page.locator(".profile-head")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
  } finally {
    fixture.db
      .prepare("UPDATE artifacts SET content=? WHERE id=?")
      .run(original.content, original.id);
    fixture.db
      .prepare("DELETE FROM artifact_objects WHERE artifact_id=?")
      .run(fileId);
    fixture.db.prepare("DELETE FROM artifacts WHERE id=?").run(fileId);
    rmSync(filePath, { force: true });
  }
}
