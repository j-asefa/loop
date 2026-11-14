import { openChatOptions } from "./browser-ui.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect } from "@playwright/test";

// A noisy RGB PNG: noise does not compress, so it is large like a photo.
function noisePng(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = randomBytes((width * 3 + 1) * height);
  // Each row starts with its filter type: none.
  for (let row = 0; row < height; row++) rows[row * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function workspaceControlsSmoke(page, fixture, engine, capture) {
  const dialog = () => page.locator("dialog[open]").last();
  const settled = async () => {
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.waitForFunction(() => history.state?.loopSheet !== true);
  };
  const close = async () => {
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await settled();
  };
  // Model changes apply to future runs. Use an idle agent here; replies to an
  // active agent now steer its existing run with that run's original settings.
  const recipient = fixture.agents.find(
    (agent) =>
      ["claude", "anthropic"].includes(agent.provider) &&
      !fixture.db
        .prepare(
          "SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','awaiting_approval')",
        )
        .get(agent.id),
  );
  assert(recipient, "Fixture needs an idle Claude agent for model selection");
  // Model/effort and upload submission are API behavior in this fixture. A
  // historical direct Codex connection is no longer a runnable destination.
  const created = await fixture.api("/connections", {
    provider: "openai",
    label: "Workspace API",
    secret: "fixture-workspace-models",
  });
  const connection = fixture.db
    .prepare("SELECT * FROM connections WHERE id=?")
    .get(created.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.base);
  const feedNav = page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Feed", exact: true });
  const feedPattern = /\/api\/feed(?:\?|$)/;
  let summary = { working: 2, queued: 3, replies_unread: 1, done_unread: 2 };
  let badgeFailure = false;
  const counts = async (route) => {
    if (
      badgeFailure &&
      new URL(route.request().url()).searchParams.get("filter") === "needs"
    ) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture badge unavailable" }),
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    await route
      .fulfill({
        response,
        json: { ...body, summary: { ...body.summary, ...summary } },
      })
      .catch((error) => {
        // Navigation can cancel an older snapshot while its fixture read finishes.
        if (!/already handled|closed|disposed/i.test(error.message))
          throw error;
      });
  };
  await page.route(feedPattern, counts);
  try {
    await page.reload();
    await expect(feedNav.locator("small")).toHaveText("8");
    await expect(feedNav.locator("small")).toHaveAttribute(
      "aria-label",
      "8 items in Feed",
    );
    const icon = await feedNav.locator("svg").boundingBox();
    const badge = await feedNav.locator("small").boundingBox();
    assert(badge.x > icon.x + icon.width / 2 && badge.y < icon.y);
    await capture("feed-total-badge");
    // Every category contributes; the accessible count remains exact above nine.
    summary = { working: 2, queued: 3, replies_unread: 1, done_unread: 5 };
    await page.reload();
    await expect(feedNav.locator("small")).toHaveText("9+");
    await expect(feedNav.locator("small")).toHaveAttribute(
      "aria-label",
      "11 items in Feed",
    );
    // The badge also loads when the app starts on another tab.
    await page.goto(fixture.base + "/?page=projects");
    await expect(feedNav.locator("small")).toHaveAttribute(
      "aria-label",
      "11 items in Feed",
    );
    summary = { working: 0, queued: 0, replies_unread: 0, done_unread: 0 };
    await page.reload();
    await expect(feedNav.locator("small")).toHaveCount(0);
    badgeFailure = true;
    await page.reload();
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "Fixture badge unavailable" });
    await expect(notice).toBeVisible();
    badgeFailure = false;
    summary = { working: 2, queued: 3, replies_unread: 1, done_unread: 5 };
    await notice.getByRole("button", { name: "Retry connection" }).click();
    await expect(notice).toHaveCount(0);
    await expect(feedNav.locator("small")).toHaveAttribute(
      "aria-label",
      "11 items in Feed",
    );
  } finally {
    await page.unroute(feedPattern, counts);
  }
  await page.goto(fixture.base);
  await page.reload();
  await page.locator(".composer-launch").click();
  await page
    .getByLabel("Agent recipient", { exact: true })
    .selectOption(recipient.id);
  const composer = page.locator(".composer");
  await expect(composer.getByLabel("Project", { exact: true })).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: /Create an agent/ }),
  ).toHaveCount(0);
  await expect(page.locator(".mobile-nav .running-count")).toHaveCSS(
    "background-color",
    "rgb(201, 162, 39)",
  );
  await openChatOptions(page);
  await composer
    .getByRole("button", { name: "Select model and effort", exact: true })
    .click();
  await expect(
    dialog().getByRole("heading", { name: "Select model", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  assert(
    await dialog()
      .locator(".sheet-body")
      .evaluate((el) => el.clientHeight > 100),
    "The model sheet must show its content, not only the drag handle",
  );
  const modelsGroup = dialog().getByRole("radiogroup", {
    name: "Models",
    exact: true,
  });
  const astra = modelsGroup.getByRole("radio", {
    name: "GPT-6 Astra · OpenAI API · Workspace API",
    exact: true,
  });
  const sonnet = modelsGroup.getByRole("radio", {
    name: "Claude Sonnet · Claude Code · Personal Claude",
    exact: true,
  });
  await expect(astra).toBeVisible();
  await expect(sonnet).toHaveAttribute("aria-checked", "true");
  await expect(
    dialog().getByRole("button", { name: /^Effort/ }),
  ).toBeDisabled();
  await expect(dialog().getByRole("combobox")).toHaveCount(0);
  await page.route(`**/api/agents/${recipient.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic model failure" }),
        })
      : route.continue(),
  );
  await astra.click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Synthetic model failure",
  );
  await expect(sonnet).toHaveAttribute("aria-checked", "true");
  await expect(astra).toHaveAttribute("aria-checked", "false");
  await page.unroute(`**/api/agents/${recipient.id}`);
  let releaseBootstrap;
  let bootstrapRequests = 0;
  await page.route("**/api/bootstrap", async (route) => {
    if (++bootstrapRequests !== 1) return route.continue();
    const response = await route.fetch();
    releaseBootstrap = () => route.fulfill({ response });
  });
  await astra.click();
  await expect(astra).toHaveAttribute("aria-checked", "true");
  await expect(dialog().getByRole("button", { name: /^Effort/ })).toContainText(
    "Low (default)",
  );
  await expect.poll(() => typeof releaseBootstrap).toBe("function");
  await dialog()
    .getByRole("button", { name: /^Effort/ })
    .click();
  const effort = dialog().getByRole("radiogroup", {
    name: "Effort",
    exact: true,
  });
  await expect(effort.getByRole("radio")).toHaveCount(3);
  await effort.getByRole("radio", { name: /^Extra high/ }).click();
  await expect(
    effort.getByRole("radio", { name: /^Extra high/ }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(dialog()).toContainText(
    "Take more time to check difficult work.",
  );
  await expect.poll(() => bootstrapRequests).toBeGreaterThan(1);
  // An older model-only refresh must not overwrite the newer effort selection.
  await releaseBootstrap();
  await page.unroute("**/api/bootstrap");
  await capture("composer-model-options");
  assert.deepEqual(
    fixture.db
      .prepare("SELECT connection_id,model,effort FROM agents WHERE id=?")
      .get(recipient.id),
    { connection_id: connection.id, model: "gpt-6-astra", effort: "xhigh" },
  );
  await dialog().getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(
    composer.getByRole("button", {
      name: "Select model and effort",
      exact: true,
    }),
  ).toContainText("GPT-6 Astra");
  await expect(
    composer.getByRole("button", {
      name: "Select model and effort",
      exact: true,
    }),
  ).toContainText("Extra high effort");
  // Attachment choices open the native file picker with the right media hints.
  await composer
    .getByRole("button", { name: "Add attachments", exact: true })
    .click();
  for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect(
      dialog().getByRole("heading", { name: "Add to message", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    for (const name of ["Camera", "Photos", "Files"])
      await expect(
        dialog().getByRole("button", { name, exact: true }),
      ).toBeInViewport({ ratio: 1 });
  }
  await expect(
    composer.getByLabel("Take a photo", { exact: true }),
  ).toHaveAttribute("capture", "environment");
  await expect(
    composer.getByLabel("Choose photos", { exact: true }),
  ).toHaveAttribute("accept", "image/*");
  await capture("attachment-options");
  const name = `brief-${engine}.txt`;
  const chooser = page.waitForEvent("filechooser");
  await dialog().getByRole("button", { name: "Files", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("Review these project notes."),
  });
  await expect(page.locator(".composer .attachment-list")).toContainText(name);
  const previewAttachment = async (parentSheets) => {
    const url = page.url();
    await page
      .getByRole("button", { name: `Preview ${name}`, exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(parentSheets + 1);
    await expect(dialog().locator(".file-preview-content pre")).toHaveText(
      "Review these project notes.",
    );
    await expect(
      dialog().getByRole("button", { name: "Close", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    assert.equal(page.url(), url);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(parentSheets);
  };
  await previewAttachment(0);
  await page.reload();
  await page.locator(".composer-launch").click();
  await expect(page.locator(".composer .attachment-list")).toContainText(name);
  await page.locator(".composer textarea").fill("Read the attached brief.");
  await page.route("**/api/runs", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic send failure" }),
        })
      : route.continue(),
  );
  await page
    .locator(".composer")
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(page.locator(".composer .attachment-list")).toContainText(name);
  await expect(page.locator(".composer textarea")).toHaveValue(
    "Read the attached brief.",
  );
  await page.unroute("**/api/runs");
  await capture("composer-upload");
  // The failed send may already be resending under its idempotency key;
  // otherwise send it again. Either way exactly one run is created.
  const send = page
    .locator(".composer")
    .getByRole("button", { name: "Send message", exact: true });
  if (await send.isEnabled()) await send.click();
  await expect(page.locator(".composer")).not.toBeVisible();
  const sentRuns = fixture.db
    .prepare("SELECT * FROM runs WHERE agent_id=? AND input=?")
    .all(recipient.id, "Read the attached brief.");
  assert.equal(sentRuns.length, 1);
  const [sent] = sentRuns;
  const fileId = JSON.parse(sent.payload).attachmentIds[0];
  const userMessage = fixture.db
    .prepare("SELECT metadata FROM messages WHERE run_id=? AND role='user'")
    .get(sent.id);
  assert.equal(JSON.parse(userMessage.metadata).attachments[0].id, fileId);
  assert.equal(JSON.parse(sent.payload).effort, "xhigh");
  await page.goto(fixture.base + "/?conversation=" + sent.conversation_id);
  await expect(dialog().locator(".message .attachment-list")).toContainText(
    name,
  );
  await previewAttachment(1);
  await expect(
    dialog().locator(".conversation-composer .attachment-list"),
  ).toHaveCount(0);
  // A short attachment sheet must also size correctly over a full-height chat.
  await dialog()
    .getByRole("button", { name: "Add attachments", exact: true })
    .click();
  await expect(
    dialog().getByRole("heading", { name: "Add to message", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    dialog().getByRole("button", { name: "Files", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await dialog().getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await dialog()
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({
      name: "follow-up.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("More context"),
    });
  await expect(
    dialog().locator(".conversation-composer .attachment-list"),
  ).toContainText("follow-up.txt");
  // A photo-sized image is scaled down and re-encoded as JPEG before upload.
  const photo = noisePng(2600, 900);
  assert.ok(photo.length > 1_500_000);
  await dialog()
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: photo });
  await expect(
    dialog().locator(".conversation-composer .attachment-list"),
  ).toContainText("photo.jpg");
  const uploaded = fixture.db
    .prepare(
      "SELECT json_extract(metadata,'$.mime') mime,json_extract(metadata,'$.size') size FROM artifacts WHERE title='photo.jpg' ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  assert.equal(uploaded?.mime, "image/jpeg");
  assert.ok(uploaded.size < photo.length, "The photo was made smaller");
  // A tunnel or proxy error page is not JSON: the message names its status.
  await page.route("**/api/uploads", (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<html><body>Bad gateway</body></html>",
    }),
  );
  await dialog()
    .getByLabel("Attach files", { exact: true })
    .setInputFiles({
      name: "lost.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Lost"),
    });
  await expect(dialog().getByRole("alert")).toContainText(
    "Upload failed (HTTP 502",
  );
  await page.unroute("**/api/uploads");
  // The error never stays in the composer's way: it can be dismissed.
  await dialog()
    .getByRole("button", { name: "Dismiss upload error", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toHaveCount(0);
  await dialog()
    .getByLabel("Reply to agent", { exact: true })
    .fill("Read this too.");
  await dialog()
    .getByRole("button", { name: "Send reply", exact: true })
    .click();
  // Sending from a thread keeps it open and shows the reply in place.
  await expect(
    dialog().getByLabel("Reply to agent", { exact: true }),
  ).toHaveValue("");
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(
    dialog().locator("article.message").filter({ hasText: "Read this too." }),
  ).toBeVisible();
  await expect(
    dialog().locator(".message .attachment-list").last(),
  ).toContainText("follow-up.txt");
  assert.equal(
    new URL(page.url()).searchParams.get("conversation"),
    sent.conversation_id,
  );
  await close();
  const team = await fixture.api("/teams", {
    name: `Disposable ${engine}`,
    managerId: fixture.agents[4].id,
    members: [fixture.agents[5].id],
  });
  await page.reload();
  await page.getByRole("button", { name: /Filter by team:/ }).click();
  await dialog().getByLabel(team.name, { exact: true }).check();
  await dialog()
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await dialog()
    .getByRole("button", { name: "Keep team", exact: true })
    .click();
  assert((await fixture.api("/teams")).some((item) => item.id === team.id));
  await dialog()
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await capture("delete-team");
  await dialog()
    .getByRole("button", { name: "Delete team", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Filter by team: All teams",
      exact: true,
    }),
  ).toBeVisible();
  assert(!(await fixture.api("/teams")).some((item) => item.id === team.id));
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page
    .locator(".project-tile")
    .filter({ has: page.locator("strong", { hasText: /^Loop$/ }) })
    .click();
  await page
    .locator(".project-tabs")
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await page.getByLabel("Upload files", { exact: true }).setInputFiles({
    name: `project-${engine}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("A project file"),
  });
  await expect(
    page.locator(".file-row").filter({ hasText: `project-${engine}.txt` }),
  ).toBeVisible();
  await capture("project-upload");
  // Restore shared fixture settings before the other browser's design checks.
  await fixture.api(
    `/agents/${recipient.id}`,
    {
      connectionId: recipient.connection_id,
      model: recipient.model,
      effort: null,
    },
    "PATCH",
  );
  fixture.db
    .prepare("UPDATE connections SET models=? WHERE id=?")
    .run(connection.models, connection.id);
  fixture.db
    .prepare(
      "UPDATE runs SET state='cancelled' WHERE agent_id=? AND state='queued'",
    )
    .run(recipient.id);
}
