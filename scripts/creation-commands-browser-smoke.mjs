import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-creation-commands-"));
let browser, server;
const requests = [];
const receipts = new Map();
const deleted = new Set();
let loseReply = true,
  refuse = false;
let holdReply = false,
  releaseReply;
const team = {
  id: "team",
  name: "Review team",
  manager_id: "manager",
  conversation_id: "thread",
  members: [],
  preset_id: "code-review",
  folder_id: "project",
};
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {PresetTeamForm} from ${JSON.stringify(resolve("src/client/TeamPresets.tsx"))};
    import {StartCodeReview} from ${JSON.stringify(resolve("src/client/CodeReview.tsx"))};
    import {TEAM_PRESETS} from ${JSON.stringify(resolve("src/shared/team-presets.ts"))};
    import {setViewOwner} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};
    import ${JSON.stringify(resolve("src/client/style.css"))};
    setViewOwner(new URLSearchParams(location.search).get('owner') || 'alice');
    const root=createRoot(document.getElementById('root'));
    const folders=[{id:'project',name:'Project',kind:'project'}];
    window.completed=0;
    const done=()=>{window.completed++;};
    window.unmount=()=>root.render(null);
    root.render(new URLSearchParams(location.search).get('mode') === 'review'
      ? React.createElement(StartCodeReview,{teams:[${JSON.stringify(team)}],folders,onStarted:done,onClose:()=>{},onCreateTeam:()=>{}})
      : React.createElement(PresetTeamForm,{preset:TEAM_PRESETS.find(p=>p.id==='code-review'),folders,connections:[{id:'connection',status:'connected',label:'Fixture',models:'[{"id":"model"}]'}],onCreated:done}));
  `,
  );
  const bundle = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    const json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<main id="root"></main><script type="module" src="/client.mjs"></script>',
      );
    } else if (path === "/client.mjs") {
      res.setHeader("content-type", "text/javascript");
      res.end(bundle.script);
    } else if (
      req.method === "POST" &&
      (path === "/api/teams/from-preset" || path === "/api/teams/team/reviews")
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ path, body });
      if (refuse) {
        json({ error: "Fixture access refused" }, 403);
        return;
      }
      if (deleted.has(body.idempotencyKey)) {
        json(
          {
            error: "This team was deleted; start a new creation",
            executionOutcome: "completed",
          },
          409,
        );
        return;
      }
      if (!receipts.has(body.idempotencyKey))
        receipts.set(
          body.idempotencyKey,
          path.endsWith("/reviews")
            ? {
                id: body.idempotencyKey,
                conversationId: "thread",
                state: "running",
                scope: body.scope,
                fingerprint: "fixture",
                createdAt: 1,
                changed: [],
                omitted: [],
                reviewers: [],
                current: true,
                freshnessError: null,
              }
            : team,
        );
      if (holdReply)
        await new Promise((done) => {
          releaseReply = done;
        });
      if (loseReply) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"');
      } else json(receipts.get(body.idempotencyKey), 201);
    } else json({ error: "Unexpected fixture route" }, 404);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const mode of process.argv[2] ? [process.argv[2]] : ["team", "review"]) {
    const url = `http://127.0.0.1:${server.address().port}/?mode=${mode}`;
    const submit = page.getByRole("button", {
      name: mode === "team" ? "Create team" : "Start review",
      exact: true,
    });
    const count = requests.length,
      effects = receipts.size;
    loseReply = true;
    await page.goto(url);
    await submit.click();
    await expect(page.getByRole("alert")).toContainText("unavailable");
    const first = requests.at(-1).body.idempotencyKey;
    await page.reload();
    refuse = true;
    await submit.click();
    await expect(page.getByRole("alert")).toContainText(
      "Fixture access refused",
    );
    refuse = false;
    loseReply = false;
    await submit.click();
    await expect.poll(() => page.evaluate(() => window.completed)).toBe(1);
    assert.deepEqual(
      requests.slice(count).map((r) => r.body.idempotencyKey),
      [first, first, first],
      `${mode} reload and recovery refusal must preserve identity`,
    );
    assert.equal(
      receipts.size,
      effects + 1,
      `${mode} recovery must not create another result`,
    );
    await page.reload();
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("loop-effect:"))
          throw new Error("Fixture storage unavailable");
        return set.call(this, key, value);
      };
    });
    await submit.click();
    await expect(page.getByRole("alert")).toContainText("nothing was sent");
    assert.equal(
      requests.length,
      count + 3,
      `${mode} must persist before dispatch`,
    );
    await page.reload();
    refuse = true;
    await submit.click();
    await expect(page.getByRole("alert")).toContainText(
      "Fixture access refused",
    );
    const rejected = requests.at(-1).body.idempotencyKey;
    refuse = false;
    await submit.click();
    await expect.poll(() => page.evaluate(() => window.completed)).toBe(1);
    assert.notEqual(
      requests.at(-1).body.idempotencyKey,
      rejected,
      "fresh refusal allows a new explicit request",
    );

    if (mode === "team") {
      await page.reload();
      loseReply = true;
      await submit.click();
      await expect(page.getByRole("alert")).toContainText("unavailable");
      const removed = requests.at(-1).body.idempotencyKey;
      deleted.add(removed);
      await page.reload();
      loseReply = false;
      await submit.click();
      await expect(page.getByRole("alert")).toContainText(
        "This team was deleted",
      );
      assert.equal(requests.at(-1).body.idempotencyKey, removed);
      await submit.click();
      await expect.poll(() => page.evaluate(() => window.completed)).toBe(1);
      assert.notEqual(requests.at(-1).body.idempotencyKey, removed);
    }

    loseReply = true;
    await page.reload();
    await submit.click();
    await expect(page.getByRole("alert")).toContainText("unavailable");
    const alice = requests.at(-1).body.idempotencyKey;
    await page.goto(url + "&owner=bob");
    await submit.click();
    await expect(page.getByRole("alert")).toContainText("unavailable");
    assert.notEqual(
      requests.at(-1).body.idempotencyKey,
      alice,
      "another owner cannot recover Alice's request",
    );
    await page.goto(url);
    loseReply = false;
    await submit.click();
    await expect.poll(() => page.evaluate(() => window.completed)).toBe(1);
    assert.equal(
      requests.at(-1).body.idempotencyKey,
      alice,
      "Alice recovers her own request",
    );

    await page.reload();
    const pendingCount = () =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((k) => k.startsWith("loop-effect:"))
            .length,
      );
    const priorPending = await pendingCount();
    holdReply = true;
    releaseReply = undefined;
    await submit.click();
    await expect.poll(() => typeof releaseReply).toBe("function");
    await page.evaluate(() => window.unmount());
    await expect(submit).toHaveCount(0);
    holdReply = false;
    releaseReply();
    await expect.poll(pendingCount).toBe(priorPending);
    assert.equal(
      await page.evaluate(() => window.completed),
      0,
      "late success cannot call an unmounted form's completion callback",
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    `creation-commands (${engine.name()}): reload, refusal recovery and persistence-before-dispatch passed`,
  );
} finally {
  releaseReply?.();
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(dir, { recursive: true, force: true });
}
