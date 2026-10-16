import { briefStatesSmoke } from "./brief-states-smoke.mjs";
import { briefHistorySmoke } from "./brief-history-smoke.mjs";
import { briefPaginationSmoke } from "./brief-pagination-smoke.mjs";
import { briefReadableSmoke } from "./brief-readable-smoke.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

// Production UI and endpoints, with explicit delayed/error responses for races.
export async function briefDetailsSmoke(
  page,
  fixture,
  _engine,
  capture,
  { project, root, ids, artifact, message, prompt, thread },
) {
  const { db, api, owner } = fixture;
  const sheet = page.locator("dialog.brief-sheet[open]");
  const close = () =>
    sheet.getByRole("button", { name: "Close", exact: true }).click();
  const refresh = async () => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith(root) && r.request().method() === "GET",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
    await response;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  };
  const record = page.getByRole("region", {
    name: "Project record",
    exact: true,
  });
  const select = (name) =>
    record.getByRole("tab", { name: new RegExp("^" + name) }).click();
  const all = (kind) =>
    record
      .getByRole("button", {
        name: `View full ${kind === "unfinished" ? "unfinished work" : kind} record`,
        exact: true,
      })
      .click();
  const openState = () => record.locator(".brief-item-open").first().click();
  await page
    .getByRole("button", { name: "Brief settings", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Enable brief", exact: true })
    .click();
  await expect(sheet).toHaveCount(0);

  await briefReadableSmoke(page, fixture, { project, ids, thread }, refresh);

  // An evidence load failure is not an empty record and never clears the draft.
  let releaseChoices;
  const choicesHeld = new Promise((resolve) => {
    releaseChoices = resolve;
  });
  await page.route("**/brief/decision-sources", async (route) => {
    await choicesHeld;
    await route.fulfill({
      status: 503,
      json: { error: "Evidence is temporarily unavailable" },
    });
  });
  await record
    .getByRole("button", { name: "Record a decision", exact: true })
    .click();
  await expect(sheet.getByText("Loading evidence…")).toBeVisible();
  await expect(sheet.getByText(/Save a result or send a message/)).toHaveCount(
    0,
  );
  await sheet
    .getByLabel("Decision", { exact: true })
    .fill("Ship the refined brief after review");
  await sheet
    .getByLabel("Why", { exact: true })
    .fill("Keep the project record connected to its evidence.");
  releaseChoices();
  await expect(sheet.getByRole("alert")).toContainText(
    "Evidence is temporarily unavailable",
  );
  await page.unroute("**/brief/decision-sources");
  await sheet
    .getByRole("button", { name: "Retry evidence", exact: true })
    .click();
  await expect(sheet.getByLabel("Evidence", { exact: true })).toBeVisible();
  await expect(sheet.getByLabel("Decision", { exact: true })).toHaveValue(
    "Ship the refined brief after review",
  );
  await sheet
    .getByLabel("Evidence", { exact: true })
    .selectOption("msg_" + prompt);
  await sheet
    .getByRole("button", { name: "Record decision", exact: true })
    .click();
  await expect(sheet).toHaveCount(0);
  await expect(record.getByRole("tab", { name: /^Decisions/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const decision = db
    .prepare("SELECT id FROM brief_items WHERE project_id=? AND text=?")
    .get(project, "Ship the refined brief after review").id;
  await expect(record).toContainText("Ship the refined brief after review");
  await record
    .locator(".brief-item-open")
    .filter({ hasText: "Ship the refined brief after review" })
    .click();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await capture(`decision-evidence-390-${theme}`);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByLabel("Text", { exact: true }).fill("Canceled wording");
  await sheet.getByLabel("Why", { exact: true }).fill("Canceled rationale");
  await sheet.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(sheet.getByLabel("Text", { exact: true })).toHaveValue(
    "Ship the refined brief after review",
  );
  await expect(sheet.getByLabel("Why", { exact: true })).toHaveValue(
    "Keep the project record connected to its evidence.",
  );
  await sheet
    .getByLabel("Text", { exact: true })
    .fill("Ship the refined brief with verified evidence");
  let writes = 0;
  await page.route("**/brief/items/" + decision, (route) => {
    writes++;
    return route.fulfill({
      status: 503,
      json: { error: "Save failed; your draft is still here" },
    });
  });
  await sheet
    .getByRole("button", { name: "Save edit", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(sheet.getByRole("alert")).toContainText("Save failed");
  assert.equal(writes, 1, "Rapid submission sends only one mutation");
  await refresh();
  await expect(sheet.getByRole("alert")).toContainText("Save failed");
  await expect(sheet.getByLabel("Text", { exact: true })).toHaveValue(
    "Ship the refined brief with verified evidence",
  );
  await page.unroute("**/brief/items/" + decision);
  let releaseSave;
  const saveHeld = new Promise((resolve) => {
    releaseSave = resolve;
  });
  await page.route("**/brief/items/" + decision, async (route) => {
    await saveHeld;
    await route.continue();
  });
  const saved = page.waitForResponse((response) =>
    response.url().endsWith("/brief/items/" + decision),
  );
  await sheet.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await close();
  await expect(page.getByRole("status")).toContainText("Saving your change");
  await page.getByRole("button", { name: "Goal · you", exact: false }).click();
  await expect(sheet).toHaveCount(0);
  releaseSave();
  await saved;
  await expect(record).toContainText("Ship the refined brief with verified evidence");
  await expect(page.getByText("Saving your change…", { exact: true })).toHaveCount(0);
  await expect(sheet).toHaveCount(0);
  await page.unroute("**/brief/items/" + decision);
  assert.equal(
    db.prepare("SELECT why FROM brief_items WHERE id=?").get(decision).why,
    "Keep the project record connected to its evidence.",
    "Saving new wording must not persist the rationale from a canceled edit",
  );
  assert.equal(
    db.prepare("SELECT pinned FROM brief_items WHERE id=?").get(decision)
      .pinned,
    1,
  );
  const openDecision = () =>
    record
      .locator(".brief-item-open")
      .filter({ hasText: "Ship the refined brief with verified evidence" })
      .click();
  await openDecision();
  await sheet.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  assert.equal(
    db.prepare("SELECT pinned FROM brief_items WHERE id=?").get(decision)
      .pinned,
    0,
  );
  await openDecision();
  await sheet.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  assert.equal(
    db.prepare("SELECT pinned FROM brief_items WHERE id=?").get(decision)
      .pinned,
    1,
  );

  // Refreshed source availability reaches an open sheet without losing a draft.
  await select("State");
  await all("state");
  await expect(sheet.locator(".brief-item-open")).toHaveCount(1);
  await close();
  await openState();
  await expect(sheet.locator(".brief-source a")).toHaveCount(1);
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(artifact);
  await refresh();
  await expect(sheet.locator(".brief-source a")).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: "Source unavailable", exact: true }),
  ).toBeDisabled();
  await capture("source-unavailable-after-refresh");
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByLabel("Text", { exact: true }).fill("Keep my active draft");
  db.prepare("UPDATE artifacts SET archived=0 WHERE id=?").run(artifact);
  await refresh();
  await expect(sheet.getByLabel("Text", { exact: true })).toHaveValue(
    "Keep my active draft",
  );
  await sheet.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await expect(sheet.locator(".brief-source a")).toHaveCount(1);
  await expect(
    sheet.getByRole("button", { name: "Open source", exact: true }),
  ).toBeEnabled();
  // A later generated view can stop citing the selected item altogether.
  const published = db.prepare(
    "SELECT id,view FROM project_briefs WHERE project_id=? ORDER BY version DESC LIMIT 1",
  ).get(project);
  const view = JSON.parse(published.view);
  db.prepare("UPDATE project_briefs SET view=? WHERE id=?").run(
    JSON.stringify({
      ...view,
      headline: { ...view.headline, cite: [] },
      state: [],
      decisions: [],
      open_questions: [],
      unfinished: [],
    }),
    published.id,
  );
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(artifact);
  await refresh();
  await expect(sheet.locator(".brief-source a")).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: "Source unavailable", exact: true }),
  ).toBeDisabled();
  db.prepare("UPDATE project_briefs SET view=? WHERE id=?").run(
    published.view,
    published.id,
  );
  db.prepare("UPDATE artifacts SET archived=0 WHERE id=?").run(artifact);
  await refresh();
  await expect(sheet.locator(".brief-source a")).toHaveCount(1);
  await close();

  // Multiple citations have independent links; the footer requires a choice.
  db.prepare(
    "UPDATE brief_items SET cites=?,cite_stale=1,next=?,blocker=? WHERE id=?",
  ).run(
    JSON.stringify([
      {
        ref: "res_" + artifact,
        quote: "Published evidence from the original result.",
      },
      { ref: "msg_" + prompt, quote: "Owner message evidence." },
      { ref: "res_missing", quote: "A retained quote from a removed source." },
    ]),
    "Review every cited source.",
    "Waiting for the source check.",
    ids.state[0],
  );
  await refresh();
  await select("State");
  await openState();
  await expect(sheet.locator(".brief-source")).toHaveCount(3);
  await expect(
    sheet.getByRole("button", { name: "Open source", exact: true }),
  ).toBeDisabled();
  await expect(sheet).toContainText("A source has changed");
  await expect(sheet).toContainText("Source unavailable");
  await expect(
    sheet.locator(".brief-source").last().getByRole("link"),
  ).toHaveCount(0);
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(artifact);
  await refresh();
  await expect(sheet.locator(".brief-source a")).toHaveCount(1);
  await expect(
    sheet.getByRole("button", { name: "Open source", exact: true }),
  ).toBeEnabled();
  db.prepare("UPDATE artifacts SET archived=0 WHERE id=?").run(artifact);
  await refresh();
  await expect(sheet.locator(".brief-source a")).toHaveCount(2);
  await expect(
    sheet.getByRole("button", { name: "Open source", exact: true }),
  ).toBeDisabled();
  await close();
  db.prepare("UPDATE artifacts SET archived=1 WHERE id=?").run(artifact);
  await refresh();
  await openState();
  await expect(sheet.locator(".brief-source a")).toHaveCount(1);
  await expect(
    sheet.getByRole("button", { name: "Open source", exact: true }),
  ).toBeEnabled();
  db.prepare("UPDATE artifacts SET archived=0 WHERE id=?").run(artifact);
  await refresh();
  await expect(sheet.locator(".brief-source a")).toHaveCount(2);
  await expect(sheet.getByLabel("Source to open", { exact: true })).toHaveValue("");
  await expect(
    sheet.getByRole("button", { name: "Open source", exact: true }),
  ).toBeDisabled();
  await sheet
    .getByLabel("Source to open", { exact: true })
    .selectOption("msg_" + prompt);
  await sheet.getByRole("button", { name: "Open source", exact: true }).click();
  await expect(
    page.locator(`.conversation-sheet #message-${prompt}`),
  ).toHaveClass(/anchored/);
  await page
    .locator("dialog.conversation-sheet[open]")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await openState();
  await sheet.locator(".brief-source").first().getByRole("link").click();
  await expect(
    page.locator(`.conversation-sheet #message-${message}`),
  ).toHaveClass(/anchored/);
  await page
    .locator("dialog.conversation-sheet[open]")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await openState();
  for (const width of [320, 390, 430, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      assert(
        await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth),
        "Evidence sheet must not overflow horizontally",
      );
      const small = await sheet
        .locator("button, a, select, summary")
        .evaluateAll((elements) =>
          elements
            .filter((el) => {
              const box = el.getBoundingClientRect();
              return box.height > 0 && (box.height < 44 || box.width < 44);
            })
            .map((el) => el.textContent || el.getAttribute("aria-label")),
        );
      assert.deepEqual(small, [], "Evidence controls need 44px targets");
      const footer = await sheet.locator(".sheet-footer").boundingBox();
      const viewportHeight = await page.evaluate(() => innerHeight);
      assert(
        footer &&
          footer.y >= -1 &&
          footer.y + footer.height <= viewportHeight + 1,
        "The complete footer stays in the viewport (one CSS pixel rounding tolerance)",
      );
      await capture(`evidence-${width}-${theme}`);
    }
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.setProperty("--reading-size", "24px");
  });
  await expect(sheet.getByRole("tab", { name: /^Evidence/ })).toBeVisible();
  await sheet.getByRole("tab", { name: /^Evidence/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    sheet.getByRole("tab", { name: "History", exact: true }),
  ).toBeFocused();
  await expect(sheet.getByText("Version 2", { exact: true })).toBeVisible();
  await capture("history-large-text-320");
  await page.keyboard.press("Home");
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByLabel("Text", { exact: true }).focus();
  await page.setViewportSize({ width: 320, height: 480 });
  await expect(sheet.getByLabel("Text", { exact: true })).toBeInViewport({
    ratio: 0.5,
  });
  await expect(
    sheet.getByRole("button", { name: "Save edit", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await capture("edit-small-viewport-320");
  await sheet.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(record.locator(".brief-item-open").first()).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("--reading-size"),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Slow background reads cannot erase an authoritative mutation response.
  let releaseOld;
  const oldPage = await api(root),
    heldOld = new Promise((resolve) => {
      releaseOld = resolve;
    });
  await page.route("**/api" + root, async (route) => {
    await heldOld;
    await route.fulfill({ json: oldPage });
  });
  const oldRequest = page.waitForRequest((r) => r.url().endsWith(root));
  await page.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
  await oldRequest;
  await page.getByRole("button", { name: "Goal · you", exact: false }).click();
  await sheet
    .getByLabel("Goal · you")
    .fill("Keep the successful goal after an older response.");
  await sheet.getByRole("button", { name: "Save goal", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const oldResponse = page.waitForResponse((r) => r.url().endsWith(root));
  releaseOld();
  await oldResponse;
  await page.unroute("**/api" + root);
  await expect(page.locator(".brief-goal")).toContainText(
    "Keep the successful goal",
  );

  // Every lifecycle remains available, including pinned wording.
  for (const [tab, kind, id, label, status] of [
    ["Decisions", "decision", decision, "Mark superseded", "superseded"],
    [
      "Questions",
      "question",
      ids.open_questions[0],
      "Mark answered",
      "answered",
    ],
    ["Next", "unfinished", ids.unfinished[0], "Mark done", "done"],
    ["State", "state", ids.state[0], "Retire", "retired"],
  ]) {
    await select(tab);
    await record.locator(".brief-item-open").first().click();
    await sheet.locator(".brief-lifecycle summary").click();
    await sheet.getByRole("button", { name: label, exact: true }).click();
    await expect(sheet).toHaveCount(0);
    assert.equal(
      db.prepare("SELECT status FROM brief_items WHERE id=?").get(id).status,
      status,
    );
    await all(kind);
    await expect(sheet.locator(".brief-item")).not.toHaveCount(0);
    await close();
  }

  // A ledger larger than a server page must remain complete without duplicates.
  const template = db
    .prepare("SELECT * FROM brief_items WHERE id=?")
    .get(ids.decisions[0]);
  const fields = Object.keys(template),
    insert = db.prepare(
      `INSERT INTO brief_items(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
    );
  for (let n = 0; n < 55; n++) {
    const value = {
      ...template,
      id: randomUUID(),
      text: `Historical decision ${n + 1}`,
      status: "superseded",
      supersedes: null,
      pinned: 0,
      updated_at: template.updated_at - n - 1,
    };
    insert.run(...fields.map((field) => value[field]));
  }
  await select("Decisions");
  await all("decision");
  await expect(sheet.locator(".brief-item")).toHaveCount(50);
  let pages = 0;
  const countPages = (request) => {
    if (request.url().includes("/brief/items?kind=decision&before=")) pages++;
  };
  page.on("request", countPages);
  await sheet
    .getByRole("button", { name: "Show more", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  const total = db
    .prepare(
      "SELECT count(*) n FROM brief_items WHERE project_id=? AND kind='decision'",
    )
    .get(project).n;
  await expect(sheet.locator(".brief-item")).toHaveCount(total);
  assert.equal(pages, 1, "Rapid pagination must share one request");
  page.off("request", countPages);
  await close();
  const firstPage = await api(root + "/items?kind=decision");
  const remainingPage = await api(
    root + "/items?kind=decision&before=" + encodeURIComponent(firstPage.before),
  );
  await all("decision");
  await expect(sheet.locator(".brief-item")).toHaveCount(firstPage.items.length);
  await briefPaginationSmoke(page, {
    pattern: "**/brief/items?kind=decision&before=*",
    endpoint: root + "/items",
    first: firstPage,
    remaining: remainingPage,
    more: sheet.getByRole("button", { name: "Show more", exact: true }),
    rows: sheet.locator(".brief-item"),
    total,
  });
  await close();
  await briefHistorySmoke(page, fixture, capture, { project, root, ids });
  await briefStatesSmoke(page, fixture, capture, { project, root, ids });
}
