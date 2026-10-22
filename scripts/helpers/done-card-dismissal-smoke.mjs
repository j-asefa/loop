import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export async function doneCardDismissalSmoke(page, fixture, engine) {
  const client =
    engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const swipe = async (row) => {
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    const x = Math.min(350, box.x + box.width - 30),
      y = box.y + Math.min(40, box.height / 2);
    if (client) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      for (let step = 1; step <= 8; step++) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x - (170 * step) / 8, y, id: 1 }],
        });
        await page.waitForTimeout(16);
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } else {
      // WebKit has no CDP touch injection; dispatch the card's pointer sequence.
      const pointer = {
        pointerType: "touch",
        pointerId: 1,
        clientX: x,
        clientY: y,
        bubbles: true,
      };
      await row.dispatchEvent("pointerdown", pointer);
      for (let step = 1; step <= 8; step++) {
        await row.dispatchEvent("pointermove", {
          ...pointer,
          clientX: x - (170 * step) / 8,
        });
        await page.waitForTimeout(16);
      }
      await row.dispatchEvent("pointerup", { ...pointer, clientX: x - 170 });
    }
    await page.waitForTimeout(300);
  };
  try {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    const row = page.locator(
      `.inbox-row[aria-label^="${fixture.conversations[0].title}"]`,
    );
    await expect(row).toHaveCount(1);
    await swipe(row);
    await expect(row).toHaveCount(0);
    await page.reload({ waitUntil: "networkidle" });
    await expect(row).toHaveCount(0);
    // Restore through the API to check the UI's Undo separately after reload.
    const cardKey = "run:" + fixture.conversations[0].run;
    await fixture.api(
      `/feed/${fixture.conversations[0].id}`,
      { hidden: false, cardKey },
      "PATCH",
    );
    await page.reload({ waitUntil: "networkidle" });
    await swipe(row);
    const toast = page
      .getByRole("status")
      .filter({ hasText: "Removed from Done" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(row).toHaveCount(1);
    // A Done dismissal must not hide follow-up work or its eventual result.
    const target = fixture.conversations[0];
    const followUp = randomUUID();
    const started = Date.now();
    fixture.db
      .prepare(
        `
        INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,worker_id,created_at,updated_at)
        SELECT ?,owner_id,agent_id,conversation_id,'Follow-up stays visible','running',?,payload,'fixture',?,?
        FROM runs WHERE id=?
      `,
      )
      .run(followUp, followUp, started, started, target.run);
    await page.reload({ waitUntil: "networkidle" });
    const before = (await fixture.api("/feed?filter=done&expand=results")).summary;
    await swipe(row);
    await expect(row).toHaveCount(0);
    assert.deepEqual((await fixture.api("/feed?filter=done&expand=results")).summary, before);
    let dismissRequests = 0;
    const countDismiss = (request) => {
      if (
        request.method() === "PATCH" &&
        new URL(request.url()).pathname === `/api/feed/${target.id}`
      )
        dismissRequests++;
    };
    page.on("request", countDismiss);
    for (const [state, filter] of [
      ["running", "working"],
      ["queued", "queued"],
      ["paused", "done"],
    ]) {
      fixture.db
        .prepare("UPDATE runs SET state=? WHERE id=?")
        .run(state, followUp);
      await page.goto(`${fixture.base}/?filter=${filter}`, {
        waitUntil: "networkidle",
      });
      if (state === "paused") {
        const showAll = page
          .getByRole("region", { name: "Needs you", exact: true })
          .getByRole("button", { name: "Show all", exact: true });
        if (await showAll.isVisible()) await showAll.click();
      }
      const activeRow = page.locator(
        '.inbox-row[aria-label^="Follow-up stays visible"]',
      );
      await expect(activeRow).toHaveCount(1);
      await expect(
        activeRow.locator("xpath=../..").locator(".swipe-under"),
      ).toHaveCount(0);
      await swipe(activeRow);
      await expect(activeRow).toHaveCount(1);
    }
    page.off("request", countDismiss);
    assert.equal(dismissRequests, 0, "Active and waiting cards cannot be swiped away");
    fixture.db
      .prepare("UPDATE runs SET state='completed',updated_at=? WHERE id=?")
      .run(started + 1, followUp);
    fixture.db
      .prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','The follow-up result is visible.',?)",
      )
      .run(randomUUID(), fixture.owner, target.id, followUp, started + 1);
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    const newResult = page.locator(
      '.inbox-row[aria-label^="Follow-up stays visible"]',
    );
    await expect(newResult).toHaveCount(1);
    await expect(newResult).toContainText("The follow-up result is visible.");

    // Restoring an earlier result alongside the new one must preserve both
    // cards, their reading sheets, and their independent swipe/Undo controls.
    await fixture.api(`/feed/${target.id}`, { hidden: false, cardKey }, "PATCH");
    await page.reload({ waitUntil: "networkidle" });
    await expect(row).toHaveCount(1);
    await expect(newResult).toHaveCount(1);
    await row.click();
    const reader = page.locator("dialog.feed-reading-sheet[open]");
    await expect(reader.locator(".result-title")).toHaveText(target.title);
    await expect(reader.locator(".artifact-body")).not.toContainText("The follow-up result is visible.");
    await reader.locator(":scope > .sheet-inner > .sheet-head")
      .getByRole("button", { name: "Close", exact: true }).click();
    await expect(reader).toHaveCount(0);
    await swipe(newResult);
    await expect(newResult).toHaveCount(0);
    await expect(row).toHaveCount(1);
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(newResult).toHaveCount(1);
    await expect(row).toHaveCount(1);

    // Old failures in Needs you can be swiped away, without removing their
    // conversation's Done result, changing execution or hiding other work.
    for (const state of ["failed", "interrupted"]) {
      const failed = randomUUID();
      const time = Date.now();
      fixture.db
        .prepare(
          `
        INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,error,created_at,updated_at)
        SELECT ?,owner_id,agent_id,conversation_id,'Dismiss this old failure',?,?,payload,'Historical failure',?,?
        FROM runs WHERE id=?
      `,
        )
        .run(failed, state, failed, time, time, followUp);
      const doneBefore = (await fixture.api("/feed?filter=done&expand=results")).items;
      const runsBefore = fixture.db
        .prepare("SELECT id,state FROM runs ORDER BY id")
        .all();
      await page.reload({ waitUntil: "networkidle" });
      const needs = page.getByRole("region", {
        name: "Needs you",
        exact: true,
      });
      const showAll = needs.getByRole("button", {
        name: "Show all",
        exact: true,
      });
      if (await showAll.isVisible()) await showAll.click();
      const failedRow = needs.locator(
        '.inbox-row[aria-label^="Dismiss this old failure"]',
      );
      await expect(failedRow).toBeVisible();
      await swipe(failedRow);
      await expect(failedRow).toHaveCount(0);
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Dismissed from Needs you" }),
      ).toBeVisible();
      const record = fixture.db
        .prepare("SELECT state,attention_dismissed_at FROM runs WHERE id=?")
        .get(failed);
      assert.equal(record.state, state);
      assert(record.attention_dismissed_at > 0);
      assert.deepEqual(
        fixture.db.prepare("SELECT id,state FROM runs ORDER BY id").all(),
        runsBefore,
      );
      assert.deepEqual(
        (await fixture.api("/feed?filter=done&expand=results")).items,
        doneBefore,
      );
      await page.reload({ waitUntil: "networkidle" });
      await expect(failedRow).toHaveCount(0);
      await expect(newResult).toContainText("The follow-up result is visible.");
    }

    // Several pages can belong to the same thread. Load more must retain
    // every result rather than deduplicating the page by conversation.
    const finishedAt = Date.now();
    for (let i = 0; i < 125; i++) {
      const run = randomUUID();
      fixture.db.prepare(`
        INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
        SELECT ?,owner_id,agent_id,conversation_id,?,'completed',?,payload,?,?
        FROM runs WHERE id=?
      `).run(run, `Historical result ${i}`, run, finishedAt, finishedAt, target.run);
      fixture.db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant',?,?)",
      ).run(randomUUID(), fixture.owner, target.id, run, `Completed output ${i}`, finishedAt);
    }
    await page.reload({ waitUntil: "networkidle" });
    const history = page.locator('.inbox-results .inbox-row[aria-label^="Historical result "]');
    await expect(history).toHaveCount(40);
    for (const count of [80, 120, 125]) {
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      await expect(history).toHaveCount(count);
    }
    await expect(row).toHaveCount(1);
    await expect(newResult).toHaveCount(1);
    const newest = randomUUID();
    fixture.db.prepare(`
      INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
      SELECT ?,owner_id,agent_id,conversation_id,'New result while reading','completed',?,payload,?,?
      FROM runs WHERE id=?
    `).run(newest, newest, finishedAt + 1, finishedAt + 1, target.run);
    fixture.db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Just finished',?)",
    ).run(randomUUID(), fixture.owner, target.id, newest, finishedAt + 1);
    let refreshRequests = 0;
    const countRefresh = (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/cards") && url.searchParams.get("view") === "done") refreshRequests++;
    };
    page.on("request", countRefresh);
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(page.locator('.inbox-results .inbox-row[aria-label^="New result while reading"]')).toHaveCount(1);
    await expect(history).toHaveCount(125);
    await expect(row).toHaveCount(1);
    await expect(newResult).toHaveCount(1);
    page.off("request", countRefresh);
    assert(refreshRequests <= 2, "Refreshing loaded history must use at most two Done requests per source");
    // An action below the pages refreshed this time updates the cached window
    // immediately, so refresh cannot resurrect a swipe or lose its Undo.
    await swipe(row);
    await expect(row).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(row).toHaveCount(0);
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(row).toHaveCount(1);
    await expect(history).toHaveCount(125);

    // Exercise the production combined Feed with two nonempty sources. A
    // failed local refresh must retain all pages loaded before the outage.
    await page.route("**/session", route => route.fulfill({json: {csrf: "fixture-csrf"}}));
    await page.route("**/api/capabilities", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), pairedDevices: true } });
    });
    await page.route("**/api/agent-sources", (route) => route.fulfill({
      json: [{ id: "docker:feed-fixture", name: "Fixture remote" }],
    }));
    let remoteWorking = 0;
    let remoteLegacy = false;
    let remoteHidden = false;
    const remoteActions = [];
    let rejectSave = false, saveFailureRelease;
    let remoteFiles = 0, localFiles = 0;
    await page.route("**/api/objects/shared-object", route => {
      localFiles++;
      return route.fulfill({contentType:"text/plain",body:"Wrong local attachment"});
    });
    const remoteEntry = (await (await page.request.get(`${fixture.base}/api/v1/cards?view=done&limit=1`)).json()).items[0];
    remoteEntry.card.id = "d:run:remote-run";
    remoteEntry.card.source.conversation_id = "remote-thread";
    remoteEntry.card.source.run_id = "remote-run";
    remoteEntry.card.source.message_id = "remote-message";
    remoteEntry.card.display.last_message.id = "remote-message";
    remoteEntry.card.saved = remoteEntry.card.display.last_message.saved = false;
    remoteEntry.card.display.conversation_id = "remote-thread";
    remoteEntry.card.display.done_card_key = "run:remote-run";
    remoteEntry.card.display.title = "Remote completed result";
    remoteEntry.card.display.run.id = "remote-run";
    remoteEntry.card.context.conversation_title = "Remote completed result";
    remoteEntry.card.attachments = [{id:"shared-artifact",name:"remote.txt",mime:"text/plain",size:17,href:"/?artifact=shared-artifact",download:"/api/objects/shared-object"}];
    remoteEntry.order[1] = "remote-thread\u001frun:remote-run";
    await page.route("**/api/agent-sources/*/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/objects/shared-object")) {
        remoteFiles++;
        return route.fulfill({contentType:"text/plain",body:"Remote attachment"});
      }
      if (path.endsWith("/feed/remote-thread")) {
        const body = route.request().postDataJSON();
        assert.equal(route.request().method(), "PATCH");
        assert.equal(body.cardKey, "run:remote-run");
        remoteActions.push(body.hidden ? "dismiss" : "undo");
        remoteHidden = body.hidden;
        return route.fulfill({json: {ok:true}});
      }
      if (path.endsWith("/messages/remote-message/saved")) {
        const saved = route.request().method() === "POST";
        if (saved && rejectSave) return new Promise(resolve => {
          saveFailureRelease = () => resolve(route.fulfill({status:503,json:{error:"Fixture save failed"}}));
        });
        remoteActions.push(saved ? "save" : "unsave");
        if (!saved) remoteWorking = 3;
        remoteEntry.card.saved = remoteEntry.card.display.last_message.saved = saved;
        return route.fulfill({json: {ok:true}});
      }
      if (path.includes("/v1/cards")) return route.fulfill(remoteLegacy
        ? {status: 400, json: {error: "Unsupported view"}}
        : {json: path.endsWith("/changes")
          ? {revision: "remote-revision", items: remoteHidden ? [] : [remoteEntry], removed: remoteHidden ? [remoteEntry.card.id] : [], more: false}
          : {revision: "remote-revision", items: remoteHidden ? [] : [remoteEntry], next: null}});
      const json = path.endsWith("/bootstrap")
        ? { agents: [], connections: [], folders: [] }
        : path.endsWith("/feed")
          ? { items: new URL(route.request().url()).searchParams.get("filter") === "done" ? [{...remoteEntry.card.display, pending_approvals: 0}] : [], next: null, summary: { needs: 0, working: remoteWorking, queued: 0, later_due: 0 } }
          : [];
      return route.fulfill({ json });
    });
    await page.reload({ waitUntil: "networkidle" });
    await expect(history).toHaveCount(39); // The newest result occupies one row.
    await expect(page.locator('.inbox-results .inbox-row[aria-label^="Remote completed result"]')).toHaveCount(1);
    const remoteRow = page.locator('.inbox-results .inbox-row[aria-label^="Remote completed result"]');
    await remoteRow.getByRole("button", {name:"Preview remote.txt",exact:true}).click();
    const filePreview = page.locator("dialog.file-preview-sheet[open]");
    await expect(filePreview).toContainText("Remote attachment");
    assert.equal(remoteFiles, 1);
    assert.equal(localFiles, 0);
    await filePreview.locator(":scope > .sheet-inner > .sheet-head").getByRole("button", {name:"Close",exact:true}).click();
    await expect(filePreview).toHaveCount(0);
    await swipe(remoteRow);
    await expect.poll(() => remoteActions, "Remote dismissal reaches its source").toEqual(["dismiss"]);
    await expect(remoteRow).toHaveCount(0);
    await toast.getByRole("button", {name: "Undo", exact:true}).click();
    await expect(remoteRow).toHaveCount(1);
    await remoteRow.locator("xpath=..").getByRole("button", {name:"Thread actions",exact:true}).click();
    await page.getByRole("menuitem", {name:/^Save/}).click();
    await expect.poll(() => remoteActions).toEqual(["dismiss", "undo", "save"]);
    const beforeSaveUndo = await page.getByRole("tab", {name: /^Working/}).textContent();
    await page.getByRole("status").filter({hasText:"Saved. Find it"}).getByRole("button", {name:"Undo",exact:true}).click();
    await expect.poll(() => remoteActions).toEqual(["dismiss", "undo", "save", "unsave"]);
    await expect(page.getByRole("tab", {name: /^Working/})).not.toHaveText(beforeSaveUndo);
    await remoteRow.locator("xpath=..").getByRole("button", {name:"Thread actions",exact:true}).click();
    await page.getByRole("menuitem", {name:/^Save/}).click();
    const switchedUndo = page.getByRole("status").filter({hasText:"Saved. Find it"}).getByRole("button", {name:"Undo",exact:true});
    await expect(switchedUndo).toBeVisible();
    await page.getByRole("tab", {name:/^Working/}).click();
    await switchedUndo.click();
    await page.waitForLoadState("networkidle");
    await expect(remoteRow).toHaveCount(0);
    await expect(page.getByRole("tab", {name:/^Working/})).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", {name:"Done",exact:true}).click();
    await expect(remoteRow).toHaveCount(1);
    // A failed mutation has no server delta to repair an optimistic cache.
    rejectSave = true;
    await remoteRow.locator("xpath=..").getByRole("button", {name:"Thread actions",exact:true}).click();
    await page.getByRole("menuitem", {name:/^Save/}).click();
    await expect.poll(() => !!saveFailureRelease).toBe(true);
    await page.getByRole("tab", {name:/^Working/}).click();
    saveFailureRelease();
    await page.waitForLoadState("networkidle");
    rejectSave = false;
    await page.getByRole("tab", {name:"Done",exact:true}).click();
    await expect(remoteRow).toHaveCount(1);
    await remoteRow.locator("xpath=..").getByRole("button", {name:"Thread actions",exact:true}).click();
    await expect(page.getByRole("menuitem", {name:/^Save/})).toBeVisible();
    await page.getByRole("menuitem", {name:/^Save/}).click();
    await expect(page.getByRole("status").filter({hasText:"Saved. Find it"})).toBeVisible();
    await remoteRow.locator("xpath=..").getByRole("button", {name:"Thread actions",exact:true}).click();
    await page.getByRole("menuitem", {name:"Remove from Saved",exact:true}).click();
    await page.getByRole("tab", {name:/^Working/}).click();
    await page.getByRole("status").filter({hasText:"Removed from Saved."}).getByRole("button", {name:"Undo",exact:true}).click();
    await page.getByRole("tab", {name:"Done",exact:true}).click();
    await remoteRow.locator("xpath=..").getByRole("button", {name:"Thread actions",exact:true}).click();
    await expect(page.getByRole("menuitem", {name:"Remove from Saved",exact:true})).toBeVisible();
    await page.keyboard.press("Escape");

    for (const count of [79, 119, 125]) {
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      await expect(history).toHaveCount(count);
    }
    const workingCount = Number((await page.getByRole("tab", { name: /^Working/ }).textContent()).replace("Working", "")) - remoteWorking;
    let localUnavailable = false;
    let localLegacy = false;
    await page.route("**/api/v1/cards**", (route) =>
      localLegacy ? route.fulfill({status: 400, json: {error: "Unsupported Done view"}}) : localUnavailable && new URL(route.request().url()).searchParams.get("view") === "done"
        ? route.fulfill({ status: 503, json: { error: "Fixture source unavailable" } })
        : route.continue(),
    );
    // Replace a source with an older server, then upgrade it again without
    // reloading the SPA. Contract transitions must retain all loaded history.
    localLegacy = true;
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await page.waitForLoadState("networkidle");
    await expect(history).toHaveCount(125);
    localLegacy = false;
    for (let i=0;i<4;i++) {
      await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
      await page.waitForLoadState("networkidle");
      await expect(history).toHaveCount(125);
    }
    localUnavailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(page.getByText("Some environments could not refresh. Showing their last loaded threads.")).toBeVisible();
    await expect(history).toHaveCount(125);
    await expect(row).toHaveCount(1);
    await expect(newResult).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    // Returning to Done must recover the same window from the view cache,
    // even though another filter has replaced the component's source cache.
    await page.getByRole("tab", { name: /^Working/ }).click();
    await expect(history).toHaveCount(0);
    await page.getByRole("tab", { name: "Done", exact: true }).click();
    await expect(page.getByText("Some environments could not refresh. Showing their last loaded threads.")).toBeVisible();
    await expect(history).toHaveCount(125);
    await expect(row).toHaveCount(1);
    await expect(newResult).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^Working/ }).locator(".chip-count"))
      .toHaveText(String(workingCount + remoteWorking));
    remoteWorking = 2;
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(page.getByRole("tab", { name: /^Working/ }).locator(".chip-count"))
      .toHaveText(String(workingCount + remoteWorking));
    await expect(history).toHaveCount(125);

    // A brief reconnect may append a page before the next outage. It must
    // extend the restored source cache instead of replacing its earlier pages.
    localUnavailable = false;
    remoteLegacy = true;
    await page.reload({ waitUntil: "networkidle" });
    await expect(history).toHaveCount(39);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(history).toHaveCount(79);
    localUnavailable = true;
    await page.getByRole("tab", { name: /^Working/ }).click();
    await expect(history).toHaveCount(0);
    await page.getByRole("tab", { name: "Done", exact: true }).click();
    await expect(page.getByText("Some environments could not refresh. Showing their last loaded threads.")).toBeVisible();
    await expect(history).toHaveCount(79);
    localUnavailable = false;
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(history).toHaveCount(119);
    localUnavailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(page.getByText("Some environments could not refresh. Showing their last loaded threads.")).toBeVisible();
    await expect(history).toHaveCount(119);
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toBeVisible();
    // A burst larger than two legacy pages must reconcile automatically while
    // retaining the already-loaded older window.
    localUnavailable = false;
    const burstAt = Date.now() + 1000;
    fixture.db.transaction(() => {
      for (let i=0;i<125;i++) {
        const run = randomUUID();
        fixture.db.prepare(`INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,created_at,updated_at)
          SELECT ?,owner_id,agent_id,conversation_id,?,'completed',?,payload,?,? FROM runs WHERE id=?`)
          .run(run, `Burst completion ${i}`, run, burstAt, burstAt, target.run);
        fixture.db.prepare("INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant','Burst answer',?)")
          .run(randomUUID(), fixture.owner, target.id, run, burstAt);
      }
    })();
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(page.locator('.inbox-results .inbox-row[aria-label^="Burst completion "]')).toHaveCount(125);
    await expect(history).toHaveCount(119);
    // A replacement revision domain invalidates old history, unlike an outage.
    // The fresh domain has several pages; failing its older pages must never
    // resurrect rows retained from the invalidated domain.
    let resetPending = true, freshUnavailable = true;
    await page.route("**/api/v1/cards**", route => {
      const url = new URL(route.request().url());
      if (resetPending && url.pathname.endsWith("/changes")) {
        resetPending = false;
        return route.fulfill({status:409,json:{error:"Fixture revision domain replaced"}});
      }
      if (freshUnavailable || url.searchParams.has("before"))
        return route.fulfill({status:503,json:{error:"Fixture old pages unavailable"}});
      return route.fallback();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(history).toHaveCount(0);
    await expect(page.locator('.inbox-results .inbox-row[aria-label^="Burst completion "]')).toHaveCount(0);
    await expect(remoteRow).toHaveCount(1);
    await expect(page.getByText("Some environments could not refresh. Showing their last loaded threads.")).toBeVisible();
    freshUnavailable = false;
    await page.evaluate(() => window.dispatchEvent(new Event("loop-source-refresh")));
    await expect(page.locator('.inbox-results .inbox-row[aria-label^="Burst completion "]')).toHaveCount(40);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.getByText("Couldn’t load the Feed from any environment.")).toBeVisible();
    await expect(history).toHaveCount(0);
  } finally {
    await client?.detach();
  }
}
