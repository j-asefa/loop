import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";
import { engineForRun } from "./helpers/engines.mjs";

const engine = await engineForRun(import.meta.url);

const dir = await mkdtemp(join(tmpdir(), "loop-composer-context-"));
let browser, server;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};
    import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
    import {flushSync} from ${JSON.stringify(resolve("node_modules/react-dom/index.js"))};
    import {useComposerContextDraft} from ${JSON.stringify(resolve("src/client/app/useComposerContextDraft.ts"))};
    import {readAppNavigation} from ${JSON.stringify(resolve("src/client/app/Navigation.ts"))};
    import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
    import {sessionDraft,emptySharedDraft} from ${JSON.stringify(resolve("src/client/workspace-drafts.ts"))};
    const initial=readAppNavigation(new URL("/?share=1&question=Incoming",location.origin));
    for(const [owner,source,label] of [["alice","","Alice"],["bob","","Bob"],["alice","docker:remote","Remote Alice"]]) {
      ownerSession.change(owner);
      sessionDraft(owner,source,"composer").write({selected:label,replyContext:null,folderChoice:label+" folder"});
      sessionDraft(owner,source,"share").write({...emptySharedDraft(),question:label+" share"});
    }
    function Probe(){
      const [scope,setScope]=React.useState({owner:"alice",source:""});
      window.scope=(owner,source="")=>flushSync(()=>{ownerSession.change(owner);setScope({owner,source});});
      const draft=useComposerContextDraft({...scope,initial,conversation:null});
      window.edit=()=>flushSync(()=>{draft.setSelected("Edited Alice");draft.setSharedDraft({...draft.sharedDraft,question:"Edited share"});});
      window.capture=()=>draft.captureGlobalComposer();
      window.restore=()=>flushSync(()=>draft.restoreGlobalComposer());
      window.stored=(owner,source="")=>({composer:sessionDraft(owner,source,"composer").read(),share:sessionDraft(owner,source,"share").read()});
      return React.createElement("output",null,JSON.stringify({selected:draft.selected,folder:draft.folderChoice,question:draft.sharedDraft.question}));
    }
    ownerSession.change("alice");
    createRoot(document.getElementById("root")).render(React.createElement(Probe));
  `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
    }
    if (url.pathname.startsWith("/client.")) {
      res.setHeader(
        "content-type",
        url.pathname.endsWith("mjs") ? "text/javascript" : "text/css",
      );
      return res.end(url.pathname.endsWith("mjs") ? script : style);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const output = page.locator("output");
  const state = () => output.evaluate((el) => JSON.parse(el.textContent));
  await expect.poll(state).toEqual({
    selected: "Alice",
    folder: "Alice folder",
    question: "Incoming",
  });
  await page.evaluate(() => window.capture());
  await page.evaluate(() => window.edit());
  await expect
    .poll(() => page.evaluate(() => window.stored("alice").composer.selected))
    .toBe("Edited Alice");
  await page.evaluate(() => window.restore());
  await expect.poll(state).toEqual({
    selected: "Alice",
    folder: "Alice folder",
    question: "Edited share",
  });
  const bobFrame = await page.evaluate(() => {
    window.scope("bob");
    return document.querySelector("output").textContent;
  });
  assert.deepEqual(JSON.parse(bobFrame), {
    selected: "Bob",
    folder: "Bob folder",
    question: "Bob share",
  });
  await expect
    .poll(() => page.evaluate(() => window.stored("bob").composer.selected))
    .toBe("Bob");
  const remoteFrame = await page.evaluate(() => {
    window.scope("alice", "docker:remote");
    return document.querySelector("output").textContent;
  });
  assert.deepEqual(JSON.parse(remoteFrame), {
    selected: "Remote Alice",
    folder: "Remote Alice folder",
    question: "Remote Alice share",
  });
  await page.evaluate(() => window.scope("alice"));
  await expect.poll(state).toEqual({
    selected: "Alice",
    folder: "Alice folder",
    question: "Edited share",
  });
  const emptyFrame = await page.evaluate(() => {
    window.scope("carol");
    return document.querySelector("output").textContent;
  });
  assert.deepEqual(JSON.parse(emptyFrame), { selected: "", question: "" });
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: composer context owner/source first-frame hydration, persisted slots, one-time incoming share and global capture/restore passed (hook fixture)`,
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await rm(dir, { recursive: true, force: true });
}
