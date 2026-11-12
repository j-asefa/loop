import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";

export async function htmlPreviewSmoke(page, fixture, capture) {
  const original = fixture.db
    .prepare("SELECT * FROM artifacts WHERE id=?")
    .get(fixture.artifacts[0]);
  const id = randomUUID(),
    call = randomUUID();
  // Keep the interactive controls beyond the old 100 KB text-preview cutoff.
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Interactive prototype</title>
    <style>body{margin:0;padding:24px;background:#f4f0ff;color:#231c35;font:18px system-ui}h1{font-size:28px}button{padding:16px;border:0;border-radius:12px;background:#513596;color:white;font:inherit}.space{height:950px}</style>
    <h1>Interactive prototype</h1><p>A page inside Loop, with its own styles.</p>
    <img alt="Embedded image" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=">
    <!--${"embedded asset ".repeat(12000)}-->
    <button onclick="this.textContent='Clicked '+(++window.clicks)">Try the prototype</button>
    <a href="#details">Jump to details</a><div class="space"></div><h2 id="details">End of prototype</h2>
    <script>
      window.clicks=0;
      window.previewChecks={};
      for(const [key,read] of Object.entries({parent:()=>parent.document.body,storage:()=>localStorage.length,cookies:()=>document.cookie})){
        try{read();previewChecks[key]='exposed'}catch{previewChecks[key]='blocked'}
      }
      fetch('/api/html-preview-probe',{credentials:'include'}).then(()=>previewChecks.network='exposed',()=>previewChecks.network='blocked');
    </script></html>`;
  const bytes = Buffer.from(html);
  const key = `objects/${createHash("sha256").update(fixture.owner).digest("hex")}/${original.run_id}/${createHash("sha256").update(call).digest("hex")}`;
  const database = fixture.db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main").file;
  const filePath = join(dirname(database), key);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  fixture.db
    .prepare(
      "INSERT INTO artifacts(id,owner_id,agent_id,conversation_id,run_id,title,kind,role,content,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,'file','file',?,?,?,?)",
    )
    .run(
      id,
      fixture.owner,
      original.agent_id,
      original.conversation_id,
      original.run_id,
      "Interactive page",
      html.slice(0, 100000),
      JSON.stringify({
        uploaded: true,
        name: "prototype.html",
        mime: "text/html",
        size: bytes.length,
        text: true,
      }),
      Date.now(),
      Date.now(),
    );
  fixture.db
    .prepare("INSERT INTO artifact_objects VALUES(?,?,?,?,?,?,?,?)")
    .run(
      id,
      fixture.owner,
      original.run_id,
      call,
      key,
      "text/html",
      bytes.length,
      createHash("sha256").update(bytes).digest("base64"),
    );
  fixture.db
    .prepare("UPDATE artifacts SET content=? WHERE id=?")
    .run(
      `Your prototype is ready. [Open the HTML page](/api/artifacts/${id}/file)`,
      original.id,
    );
  const dialog = () => page.locator("dialog[open]").last();
  const requests = [];
  const track = (request) => {
    if (request.url().includes("html-preview-probe"))
      requests.push(request.url());
  };
  page.on("request", track);
  try {
    // Published files remain discoverable from You even when hidden/archived.
    fixture.db
      .prepare("UPDATE artifacts SET feed_hidden=1,archived=1 WHERE id=?")
      .run(id);
    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(fixture.base + "/?page=profile");
      await page.getByRole("tab", { name: "Files", exact: true }).click();
      const library = page.getByRole("region", {
        name: "Your files",
        exact: true,
      });
      // Let the debounced query apply before opening a result. Applying a new
      // filter replaces the old list, including a preview opened from it.
      const searched = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/me/files" &&
          url.searchParams.get("q") === "prototype" &&
          response.ok()
        );
      });
      await library
        .getByRole("searchbox", { name: "Search files" })
        .fill("prototype");
      await searched;
      await expect(library.getByRole("status")).toHaveCount(0);
      await library.getByLabel("Type", { exact: true }).selectOption("image");
      await expect(
        library.getByText("No files match your filters."),
      ).toBeVisible();
      await library.getByLabel("Type", { exact: true }).selectOption("html");
      await library
        .getByRole("button", { name: "Preview prototype.html", exact: true })
        .click();
      await expect(
        dialog()
          .frameLocator("iframe")
          .getByRole("heading", { name: "Interactive prototype", exact: true }),
      ).toBeVisible();
      const download = page.waitForEvent("download");
      await dialog()
        .getByRole("link", { name: "Download", exact: true })
        .click();
      assert.deepEqual(readFileSync(await (await download).path()), bytes);
      await dialog()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await capture(`profile-files-${width}`);
      await library
        .getByRole("button", { name: "Open conversation", exact: true })
        .click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("conversation"))
        .toBe(original.conversation_id);
    }
    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(fixture.base + "/?artifact=" + original.id);
      await dialog()
        .getByRole("link", { name: "Open the HTML page", exact: true })
        .click();
      const frame = dialog().frameLocator("iframe");
      await expect(
        frame.getByRole("heading", {
          name: "Interactive prototype",
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog().locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
      await frame.getByRole("button", { name: "Try the prototype" }).click();
      await expect(
        frame.getByRole("button", { name: "Clicked 1" }),
      ).toBeVisible();
      assert.deepEqual(
        await frame.locator("body").evaluate(() => window.previewChecks),
        {
          parent: "blocked",
          storage: "blocked",
          cookies: "blocked",
          network: "blocked",
        },
      );
      assert.equal(
        await frame
          .locator("body")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgb(244, 240, 255)",
      );
      await expect
        .poll(() =>
          frame
            .getByAltText("Embedded image")
            .evaluate((el) => el.complete && el.naturalWidth > 0),
        )
        .toBe(true);
      await expect(
        dialog().getByRole("button", { name: "Close", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(`html-preview-${width}`);
      await frame.getByRole("link", { name: "Jump to details" }).click();
      await expect(
        frame.getByRole("heading", { name: "End of prototype" }),
      ).toBeInViewport();
      await expect(
        dialog().getByRole("button", { name: "Close", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await dialog()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(page.locator("dialog[open]")).toHaveCount(1);
    }
    // The published-file button and a Markdown file link share this preview.
    await page.goto(fixture.base + "/?artifact=" + id);
    await expect(dialog().locator(".file-text-preview")).toHaveCount(0);
    await dialog()
      .getByRole("button", { name: "Preview prototype.html", exact: true })
      .click();
    await expect(
      dialog()
        .frameLocator("iframe")
        .getByRole("heading", { name: "Interactive prototype", exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: () => false,
      }),
    );
    // Trigger a render after disabling native share in the fixture.
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await dialog()
      .getByRole("button", { name: "Preview prototype.html", exact: true })
      .click();
    const downloading = page.waitForEvent("download");
    await dialog().getByRole("link", { name: "Download", exact: true }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "prototype.html");
    assert.deepEqual(readFileSync(await download.path()), bytes);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    // Uploaded HTML uses the same sandbox, including extension-based detection
    // when the phone reports its MIME type as application/octet-stream.
    const data = new FormData();
    data.set(
      "file",
      new Blob([bytes], { type: "application/octet-stream" }),
      "uploaded.HTM",
    );
    const response = await fetch(fixture.base + "/api/uploads", {
      method: "POST",
      headers: fixture.headers,
      body: data,
    });
    assert.equal(response.status, 201);
    const uploaded = await response.json();
    try {
      fixture.db
        .prepare("UPDATE artifacts SET content=? WHERE id=?")
        .run(
          `[Open uploaded HTML](/api/objects/${uploaded.objectId})`,
          original.id,
        );
      await page.goto(fixture.base + "/?artifact=" + original.id);
      await dialog()
        .getByRole("link", { name: "Open uploaded HTML", exact: true })
        .click();
      await dialog()
        .frameLocator("iframe")
        .getByRole("button", { name: "Try the prototype" })
        .click();
      await expect(
        dialog()
          .frameLocator("iframe")
          .getByRole("button", { name: "Clicked 1" }),
      ).toBeVisible();
      await page.goBack();
      await expect(page.locator("dialog[open]")).toHaveCount(1);
    } finally {
      fixture.db.prepare("DELETE FROM artifacts WHERE id=?").run(uploaded.id);
      fixture.db
        .prepare("DELETE FROM objects WHERE id=?")
        .run(uploaded.objectId);
    }
    assert.deepEqual(
      requests,
      [],
      "HTML scripts must not send authenticated requests to Loop",
    );
  } finally {
    page.off("request", track);
    fixture.db
      .prepare("UPDATE artifacts SET content=? WHERE id=?")
      .run(original.content, original.id);
    fixture.db
      .prepare("DELETE FROM artifact_objects WHERE artifact_id=?")
      .run(id);
    fixture.db.prepare("DELETE FROM artifacts WHERE id=?").run(id);
    rmSync(filePath, { force: true });
  }
}
