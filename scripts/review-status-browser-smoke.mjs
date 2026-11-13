import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-review-status-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React, {useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {CodeReviewStatus} from ${JSON.stringify(resolve("src/client/CodeReview.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change("alice"); setShellSource("");
    function Probe() {
      const [conversation, setConversation] = useState("first");
      const [revision, setRevision] = useState(0);
      window.revise = () => flushSync(() => setRevision(n => n + 1));
      window.select = value => flushSync(() => setConversation(value));
      window.source = value => flushSync(() => {setShellSource(value); setRevision(n => n + 1);});
      window.owner = value => flushSync(() => {ownerSession.change(value); setRevision(n => n + 1);});
      return React.createElement(CodeReviewStatus, {conversationId:conversation, revision});
    }
    createRoot(document.getElementById("root")).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let failure = false,
    holdNext = false,
    completed = 1,
    prefix = "snapshot";
  const requests = [];
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<!doctype html><link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (["/client.mjs", "/client.css"].includes(url.pathname)) {
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".mjs")
          ? "text/javascript"
          : "text/css",
      });
      res.end(url.pathname.endsWith(".mjs") ? script : style);
      return;
    }
    if (url.pathname.includes("/reviews/conversation/")) {
      requests.push(url);
      const id = url.pathname.split("/").at(-1);
      const status = failure ? 503 : 200;
      const body = failure
        ? { error: "Review status unavailable" }
        : {
            id: "review-" + id,
            conversationId: id,
            state: "running",
            scope: "branch",
            fingerprint: prefix + "-" + id,
            createdAt: 1,
            changed: ["src/example.ts"],
            omitted: [".env"],
            reviewers: Array.from({ length: 3 }, (_, index) => ({
              agent_id: "reviewer-" + index,
              state: index < completed ? "completed" : "running",
              error: null,
            })),
            current: url.searchParams.has("freshness") ? true : null,
            freshnessError: null,
          };
      const send = () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (holdNext) {
        holdNext = false;
        held.push(send);
      } else send();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  for (const scenario of process.argv.length > 2
    ? process.argv.slice(2)
    : ["recovery", "freshness", "scope"]) {
    failure = scenario === "recovery";
    holdNext = false;
    completed = 1;
    prefix = "snapshot";
    requests.length = 0;
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const report = page.getByRole("complementary", {
      name: "Snapshot review status",
    });
    const notice = page.getByRole("alert");
    const check = () =>
      report.getByRole("button", { name: "Check for newer edits" }).click();
    const revise = () => page.evaluate(() => window.revise());
    try {
      await page.goto("http://127.0.0.1:" + server.address().port);
      if (scenario === "recovery") {
        await expect(notice).toContainText("Review status unavailable", {
          timeout: 12000,
        });
        assert.equal(requests.length, 3, "initial read uses bounded retries");
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(
          page.getByRole("button", { name: "Retry connection" }),
        ).toBeEnabled();
        assert.equal(requests.length, 4, "manual retry makes one request");
        failure = false;
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: ["docker:unrelated"] },
            }),
          ),
        );
        await page.waitForTimeout(100);
        assert.equal(
          requests.length,
          4,
          "another source cannot refresh this read",
        );
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: [""] },
            }),
          ),
        );
        await expect(report).toContainText("1/3 reviewers completed");
        await expect(notice).toHaveCount(0);
        failure = true;
        await revise();
        await expect(notice).toContainText("Review status unavailable", {
          timeout: 12000,
        });
        await expect(report).toContainText("1/3 reviewers completed");
        failure = false;
        await page.getByRole("button", { name: "Retry connection" }).click();
        await expect(notice).toHaveCount(0);
      } else {
        await expect(report).toContainText("1/3 reviewers completed");
        if (scenario === "freshness") {
          holdNext = true;
          await revise();
          await expect.poll(() => held.length).toBe(1);
          await expect(
            report.getByRole("button", { name: "Check for newer edits" }),
          ).toBeEnabled();
          failure = true;
          const before = requests.length;
          await check();
          await expect(notice).toContainText("Review status unavailable");
          assert.equal(requests.length, before + 1);
          assert.equal(requests.at(-1).searchParams.get("freshness"), "true");
          held.shift()();
          await page.waitForTimeout(100);
          await expect(notice).toContainText("Review status unavailable");
          failure = false;
          holdNext = true;
          await page.getByRole("button", { name: "Retry connection" }).click();
          await expect.poll(() => held.length).toBe(1);
          assert.equal(requests.at(-1).searchParams.get("freshness"), "true");
          completed = 2;
          await revise();
          held.shift()();
          await expect(report).toContainText("2/3 reviewers completed");
          await expect(report).toContainText("matched at the last check");
          await expect(notice).toHaveCount(0);
          assert.equal(requests.at(-1).searchParams.has("freshness"), false);
        } else {
          for (const [kind, value, nextPrefix] of [
            ["select", "second", "thread"],
            ["source", "docker:other", "source"],
            ["owner", "bob", "owner"],
            ["owner", "alice", "return"],
          ]) {
            holdNext = true;
            await check();
            await expect.poll(() => held.length).toBe(1);
            prefix = nextPrefix;
            holdNext = true;
            await page.evaluate(
              ([kind, value]) => window[kind](value),
              [kind, value],
            );
            await expect.poll(() => held.length).toBe(2);
            await expect(report).toHaveCount(0);
            held.pop()();
            await expect(report).toContainText(nextPrefix);
            held.shift()();
            await page.waitForTimeout(100);
            await expect(report).toContainText(nextPrefix);
            await expect(report).not.toContainText("matched at the last check");
          }
          assert(
            requests.some((url) =>
              url.pathname.startsWith("/api/agent-sources/docker%3Aother/"),
            ),
          );
        }
      }
      assert.deepEqual(errors, []);
      console.log(engine + " review status passed: " + scenario);
    } finally {
      held.splice(0).forEach((send) => send());
      await context.close();
    }
  }
} finally {
  held.splice(0).forEach((send) => send());
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
