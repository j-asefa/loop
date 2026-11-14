import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-artifact-reader-"));
let browser, server;
const held = [];
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React,{useRef,useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {useArtifactReads} from ${JSON.stringify(resolve("src/client/app/ArtifactReads.tsx"))};
    import {CollectionReadNotice} from ${JSON.stringify(resolve("src/client/CollectionRead.tsx"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
    ownerSession.change('alice');setShellSource('');
    function Probe(){
      const ownerRef=useRef('alice'),[,render]=useState(0),[opened,setOpened]=useState(''),[reply,setReply]=useState('');
      const api=useArtifactReads({ownerRef,initialArtifact:new URLSearchParams(location.search).get('artifact'),onStartOpen:()=>{},onOpen:item=>setOpened(item.card?.title??item.title),onReply:context=>setReply(context.title)});
      window.openArtifact=id=>{void api.open({id});};
      window.replyArtifact=id=>{void api.replyToArtifact({id});};
      window.typed=()=>{void api.open({card:{id:'a:missing-card'},sourceId:'',cardOwner:'alice'});};
      window.mismatch=()=>{void api.open({id:'one',cardOwner:'bob'});};
      window.owner=value=>flushSync(()=>{ownerRef.current=value;ownerSession.change(value);setOpened('');setReply('');render(n=>n+1);});
      window.source=value=>flushSync(()=>{setShellSource(value);setOpened('');setReply('');render(n=>n+1);});
      return React.createElement(React.Fragment,null,
        React.createElement('output',{id:'opened'},opened),React.createElement('output',{id:'reply'},reply),
        React.createElement('section',{id:'open-notice'},React.createElement(CollectionReadNotice,api.opening)),
        React.createElement('section',{id:'reply-notice'},React.createElement(CollectionReadNotice,api.replying)));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let failure = 0,
    holdId = "",
    label = "";
  const requests = [];
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid"),
      path = url.pathname;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<div id="root"></div><script type="module" src="/client.mjs"></script>',
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
    requests.push({ path, method: req.method });
    if (path.includes("/cards/")) return send(404, { error: "Card not found" });
    if (path.includes("/artifacts/")) {
      const id = decodeURIComponent(path.split("/").at(-1));
      const status = failure || 200,
        body = failure
          ? { error: "Artifact unavailable" }
          : {
              id,
              owner_id: "alice",
              agent_id: id === "unlinked" ? null : "agent",
              conversation_id: "thread",
              run_id: null,
              title: label + id,
              kind: "markdown",
              role: "answer",
              content: "Fixture artifact",
              metadata: id === "imported" ? '{"origin":"import"}' : "{}",
              folder_id: null,
              pinned: 0,
              archived: 0,
              version: 1,
              created_at: 1,
              updated_at: 1,
            };
      const reply = () => send(status, body);
      if (id === holdId) {
        holdId = "";
        held.push(reply);
      } else reply();
      return;
    }
    send(404, { error: "No fixture route" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const scenarios = [
      "retry-policy",
      "latest",
      "scope",
      "initial",
      "intent",
      "dismiss",
    ],
    selected = process.argv[2];
  assert(!selected || scenarios.includes(selected));
  const artifacts = () =>
    requests.filter((r) => r.path.includes("/artifacts/")).length;
  for (const scenario of selected ? [selected] : scenarios) {
    requests.length = 0;
    held.length = 0;
    failure = 0;
    holdId = scenario === "initial" ? "one" : "";
    label = "";
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${server.address().port}/${scenario === "initial" ? "?artifact=one" : ""}`,
    );
    if (scenario === "retry-policy") {
      failure = 503;
      await page.evaluate(() => window.openArtifact("one"));
      const notice = page.locator("#open-notice [role=alert]");
      await expect(notice).toContainText("Artifact unavailable");
      assert.equal(artifacts(), 1, "open uses one transient attempt");
      failure = 0;
      await notice.getByRole("button", { name: "Retry connection" }).click();
      await expect(page.locator("#opened")).toHaveText("one");
      await expect(notice).toHaveCount(0);
      assert.equal(artifacts(), 2, "open retry retains the same target");
      await page.evaluate(() => window.typed());
      await expect(notice).toContainText("Card not found");
      assert.equal(
        artifacts(),
        2,
        "a typed card 404 cannot fall back to artifact detail",
      );
      failure = 503;
      await page.evaluate(() => window.replyArtifact("two"));
      const replyNotice = page.locator("#reply-notice [role=alert]");
      await expect(replyNotice).toContainText("Artifact unavailable");
      failure = 0;
      await replyNotice
        .getByRole("button", { name: "Retry connection" })
        .click();
      await expect(page.locator("#reply")).toHaveText("two");
      await expect(replyNotice).toHaveCount(0);
      await expect(notice).toHaveCount(0);
      await page.evaluate(() => window.replyArtifact("imported"));
      await expect(page.locator("#opened")).toHaveText("imported");
      await expect(page.locator("#reply")).toHaveText("two");
      await page.evaluate(() => window.replyArtifact("unlinked"));
      await expect(page.locator("#opened")).toHaveText("unlinked");
      const before = requests.length;
      await page.evaluate(() => window.mismatch());
      assert.equal(
        requests.length,
        before,
        "a different card owner does not dispatch a read",
      );
    } else if (scenario === "intent") {
      failure = 503;
      await page.evaluate(() => window.replyArtifact("one"));
      await expect(page.locator("#reply-notice [role=alert]")).toContainText(
        "Artifact unavailable",
      );
      failure = 0;
      await page.evaluate(() => window.openArtifact("two"));
      await expect(page.locator("#opened")).toHaveText("two");
      await expect(page.locator("#reply-notice [role=alert]")).toHaveCount(0);
      await expect(page.locator("#reply")).toHaveText("");
      for (const [first, second, output] of [
        ["replyArtifact", "openArtifact", "opened"],
        ["openArtifact", "replyArtifact", "reply"],
      ]) {
        holdId = "one";
        await page.evaluate((first) => window[first]("one"), first);
        await expect.poll(() => held.length).toBe(1);
        const aborted = page.waitForEvent("requestfailed", {
          predicate: (r) => r.url().endsWith("/artifacts/one"),
        });
        await page.evaluate((second) => window[second]("two"), second);
        await aborted;
        await expect(page.locator("#" + output)).toHaveText("two");
        held.shift()();
        await expect(page.locator("#" + output)).toHaveText("two");
      }
    } else if (scenario === "dismiss") {
      await page.evaluate(() => window.typed());
      const notice = page.locator("#open-notice [role=alert]");
      await expect(notice).toContainText("Card not found");
      const before = requests.length;
      await notice
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      await expect(notice).toHaveCount(0);
      assert.equal(
        requests.length,
        before,
        "dismissal submits no read or command",
      );
    } else if (scenario === "latest") {
      for (const [action, output] of [
        ["openArtifact", "opened"],
        ["replyArtifact", "reply"],
      ]) {
        holdId = "one";
        await page.evaluate((action) => window[action]("one"), action);
        await expect.poll(() => held.length).toBe(1);
        const aborted = page.waitForEvent("requestfailed", {
          predicate: (r) => r.url().endsWith("/artifacts/one"),
        });
        await page.evaluate((action) => window[action]("two"), action);
        await aborted;
        await expect(page.locator("#" + output)).toHaveText("two");
        held.shift()();
        await expect(page.locator("#" + output)).toHaveText("two");
      }
    } else if (scenario === "scope") {
      holdId = "one";
      await page.evaluate(() => window.openArtifact("one"));
      await expect.poll(() => held.length).toBe(1);
      const aborted = page.waitForEvent("requestfailed", {
        predicate: (r) => r.url().endsWith("/artifacts/one"),
      });
      await page.evaluate(() => window.owner("bob"));
      await aborted;
      await page.evaluate(() => window.owner("alice"));
      label = "new-";
      await page.evaluate(() => window.openArtifact("two"));
      await expect(page.locator("#opened")).toHaveText("new-two");
      held.shift()();
      await expect(page.locator("#opened")).toHaveText("new-two");
      holdId = "one";
      await page.evaluate(() => window.replyArtifact("one"));
      await expect.poll(() => held.length).toBe(1);
      const sourceAborted = page.waitForEvent("requestfailed", {
        predicate: (r) => r.url().endsWith("/artifacts/one"),
      });
      await page.evaluate(() => window.source("docker:fixture"));
      await sourceAborted;
      label = "source-";
      await page.evaluate(() => window.replyArtifact("two"));
      await expect(page.locator("#reply")).toHaveText("source-two");
      held.shift()();
      await expect(page.locator("#reply")).toHaveText("source-two");
      assert(requests.some((r) => r.path.includes("docker%3Afixture")));
    } else {
      await expect.poll(() => held.length).toBe(1);
      const aborted = page.waitForEvent("requestfailed", {
        predicate: (r) => r.url().endsWith("/artifacts/one"),
      });
      await page.evaluate(() => window.openArtifact("two"));
      await aborted;
      await expect(page.locator("#opened")).toHaveText("two");
      held.shift()();
      await expect(page.locator("#opened")).toHaveText("two");
    }
    assert(
      requests.every((r) => r.method === "GET"),
      "all fixture actions are reads",
    );
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${engine} artifact-reader ${scenario}: passed`);
  }
} finally {
  for (const release of held) release();
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
