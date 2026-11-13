import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
const dir = await mkdtemp(join(tmpdir(), "loop-thread-source-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {useThreadSource} from ${JSON.stringify(resolve("src/client/useThreadSource.ts"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    import {needsWorkspaceReadRecovery} from ${JSON.stringify(resolve("src/client/workspace-read-recovery.ts"))};
    ownerSession.change('alice');setShellSource('');
    window.needsRecovery=()=>needsWorkspaceReadRecovery('docker:fixture');
    function Probe(){
      const [owner,setOwner]=useState('alice');const [revision,setRevision]=useState(0);
      window.owner=value=>flushSync(()=>{ownerSession.change(value);setOwner(value);setRevision(n=>n+1)});
      window.disable=()=>flushSync(()=>{setShellSource('docker:fixture');setRevision(n=>n+1)});
      const data=useThreadSource('docker:fixture',owner);
      return React.createElement('section',null,
        React.createElement('output',{id:'data'},data.data?.environmentName??'empty'),
        React.createElement('output',{id:'error'},data.error??''),
        React.createElement('button',{onClick:data.retry},'Retry'));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let mode = "cooldown",
    reads = 0,
    label = "healthy";
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (path === "/client.mjs" || path === "/client.css") {
      res.writeHead(200, {
        "content-type": path.endsWith(".mjs") ? "text/javascript" : "text/css",
      });
      res.end(path.endsWith(".mjs") ? script : style);
      return;
    }
    if (path.endsWith("/capabilities")) {
      if (mode === "paired") {
        send(429, { error: "Capabilities cooldown" }, { "Retry-After": "60" });
        return;
      }
      send(200, {
        pairedDevices: true,
        cardTokens: true,
        personalDecisions: true,
        personalApprovalDetails: true,
      });
      return;
    }
    if (path.endsWith("/bootstrap")) {
      reads++;
      if (mode === "cooldown") {
        send(429, { error: "Wait" }, { "Retry-After": "60" });
        return;
      }
      if (mode === "paired") {
        held.push(() => send(503, { error: "Bootstrap transient" }));
        return;
      }
      if (mode === "failure") {
        send(503, { error: "Metadata unavailable" });
        return;
      }
      const body = {
        agents: [],
        connections: [],
        folders: [],
        teams: [],
        environmentName: label,
      };
      if (mode === "slow")
        held.push(() =>
          reads < 3
            ? send(503, { error: "Slow metadata failure" })
            : send(200, body),
        );
      else if (mode === "hold") held.push(() => send(200, body));
      else send(200, body);
      return;
    }
    send(404, { error: "Unknown fixture route" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  for (const scenario of process.argv.length > 2
    ? process.argv.slice(2)
    : ["cooldown", "paired", "slow", "timeout", "recovery", "scope"]) {
    mode =
      scenario === "cooldown"
        ? "cooldown"
        : scenario === "recovery"
          ? "failure"
          : scenario === "slow"
            ? "slow"
            : scenario === "paired"
              ? "paired"
              : "hold";
    reads = 0;
    label = "old";
    const context = await browser.newContext(),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.clock.install();
      await page.goto("http://127.0.0.1:" + server.address().port);
      await expect.poll(() => reads).toBe(1);
      if (scenario === "cooldown") {
        await page.clock.fastForward(21000);
        await expect(page.locator("#error")).toContainText(
          "Retrying automatically",
        );
        mode = "healthy";
        label = "recovered";
        await page.clock.fastForward(40000);
        await expect(page.locator("#data")).toHaveText("recovered");
        assert.equal(
          reads,
          2,
          "cooldown resumes automatically without another event",
        );
      } else if (scenario === "paired") {
        await expect.poll(() => held.length).toBe(1);
        await expect(page.locator("#error")).toContainText(
          "Retrying automatically",
        );
        const response = page.waitForResponse((r) =>
          r.url().endsWith("/bootstrap"),
        );
        held.shift()();
        await response;
        await page.clock.runFor(100);
        assert.match(
          await page.locator("#error").textContent(),
          /Retrying automatically/,
          "the sibling retry cannot hide an active cooldown",
        );
        mode = "healthy";
        await page.clock.fastForward(61000);
        await expect(page.locator("#data")).toHaveText("old");
        await expect(page.locator("#error")).toBeEmpty();
      } else if (scenario === "slow") {
        const release = async () => {
          const response = page.waitForResponse((r) =>
            r.url().endsWith("/bootstrap"),
          );
          held.shift()();
          await response;
          await page.clock.runFor(20);
        };
        for (const [index, delay] of [
          [1, 2100],
          [2, 4100],
        ]) {
          await expect.poll(() => held.length).toBe(1);
          await page.clock.fastForward(7000);
          await release();
          await page.clock.fastForward(delay);
          await expect.poll(() => reads).toBe(index + 1);
        }
        await page.clock.fastForward(7000);
        await expect(page.locator("#error")).toBeEmpty();
        await release();
        await expect(page.locator("#data")).toHaveText("old");
      } else if (scenario === "timeout") {
        await expect.poll(() => held.length).toBe(1);
        await page.clock.fastForward(21000);
        await expect(page.locator("#error")).toContainText("timed out");
        assert.equal(await page.evaluate(() => window.needsRecovery()), true);
        mode = "healthy";
        label = "after timeout";
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: ["docker:fixture"] },
            }),
          ),
        );
        await expect(page.locator("#data")).toHaveText("after timeout");
      } else if (scenario === "recovery") {
        await page.clock.fastForward(2100);
        await expect.poll(() => reads).toBe(2);
        await page.clock.fastForward(4100);
        await expect.poll(() => reads).toBe(3);
        await expect(page.locator("#error")).toContainText(
          "Metadata unavailable",
        );
        assert.equal(await page.evaluate(() => window.needsRecovery()), true);
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(() => reads).toBe(4);
        await page.clock.runFor(20);
        assert.equal(
          await page.evaluate(() => window.needsRecovery()),
          false,
          "manual failure must not register automatic recovery",
        );
        mode = "healthy";
        label = "recovered";
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("loop-workspace-change", {
              detail: { sources: ["docker:fixture"] },
            }),
          ),
        );
        await expect(page.locator("#data")).toHaveText("recovered");
        await expect(page.locator("#error")).toBeEmpty();
        assert.equal(await page.evaluate(() => window.needsRecovery()), false);
      } else {
        await expect.poll(() => held.length).toBe(1);
        await page.evaluate(() => window.owner("bob"));
        await expect.poll(() => held.length).toBe(2);
        await page.evaluate(() => window.owner("alice"));
        await expect.poll(() => held.length).toBe(3);
        await page.evaluate(() => window.disable());
        held.splice(0).forEach((send) => send());
        await page.clock.fastForward(21000);
        await expect(page.locator("#data")).toHaveText("empty");
        await expect(page.locator("#error")).toBeEmpty();
      }
      assert.deepEqual(errors, []);
      console.log(engine + " thread source passed: " + scenario);
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
