// Deterministic component fixtures; no backend, credentials or paid model calls.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
mkdirSync(".tmp", { recursive: true });
const directory = mkdtempSync(".tmp/activity-ui-");
const entry = `${directory}/preview.tsx`;
writeFileSync(
  entry,
  `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PlanPanel, FileChangePanel, CommandOutputPanel} from '../../src/client/ActivityPanels';
import {HarnessPicker} from '../../src/client/HarnessPicker';
function App() {
 const [revision,setRevision]=useState(0), [conversation,setConversation]=useState('first'), [draft,setDraft]=useState('');
 const hostile='<img src=x onerror="alert(1)">';
 return <main style={{maxWidth:900,margin:'auto'}}>
  <button onClick={()=>setRevision(x=>x+1)}>Update output</button>
  <button id="switch-conversation" onClick={()=>setConversation('second')}>Switch conversation</button>
  <HarnessPicker agentId="a" conversationId={conversation} value={draft} onChange={setDraft} focusInput={()=>{}}/>
  <output aria-label="Selected command">{draft}</output>
  <PlanPanel steps={[{id:'s',text:hostile,status:revision?'completed':'in_progress'}]}/>
  <FileChangePanel path={hostile.repeat(5)} patch={'+'+hostile+'\\n-'+ 'x'.repeat(400)} state="proposed"/>
  <CommandOutputPanel command={'printf '+hostile} text={Array.from({length:400},(_,i)=>'line '+i+' revision '+revision).join('\\n')} state="running"/>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
`,
);
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "activity-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/activity-fixture") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/${relative(process.cwd(), entry)}"></script></body></html>`,
          );
        });
      },
    },
  ],
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
    headless: true,
  });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let catalog = "second";
    let releaseFirst;
    await page.route(
      "**/api/agents/a/harness?conversation=*",
      async (route) => {
        const first = route.request().url().endsWith("=first");
        if (first)
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        const token = first ? "first" : catalog;
        await route.fulfill({
          json: {
            available: true,
            commands: [
              {
                name: token,
                token: "/" + token,
                kind: "command",
                description: token,
              },
            ],
          },
        });
      },
    );
    await page.goto(
      `http://127.0.0.1:${vite.httpServer.address().port}/activity-fixture`,
    );
    await page.getByRole("heading", { name: /Command output/ }).waitFor();
    assert.equal(await page.locator("img").count(), 0);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const output = page.getByLabel("Scrollable command output");
    await output.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Follow latest output" }).waitFor();
    await page.getByRole("button", { name: "Update output" }).click();
    assert.equal(await output.evaluate((element) => element.scrollTop), 0);
    await page.getByRole("button", { name: "Follow latest output" }).click();
    assert(await output.evaluate((element) => element.scrollTop > 0));
    await page
      .getByRole("button", { name: "Commands & skills", exact: true })
      .click();
    await expect.poll(() => !!releaseFirst).toBe(true);
    await page.evaluate(() =>
      document.getElementById("switch-conversation").click(),
    );
    await page
      .getByRole("button", { name: "Commands & skills", exact: true })
      .click();
    await page.getByRole("button", { name: /\/second/ }).waitFor();
    releaseFirst();
    await expect(page.getByRole("button", { name: /\/first/ })).toHaveCount(0);
    catalog = "updated";
    await page.getByRole("button", { name: "Refresh from machine" }).click();
    await page.getByRole("button", { name: /\/updated/ }).waitFor();
    await expect(page.getByRole("button", { name: /\/second/ })).toHaveCount(0);
    await page.getByRole("button", { name: /\/updated/ }).click();
    await expect(page.getByLabel("Selected command")).toHaveText("/updated");
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "PASS activity fixtures: desktop/mobile, escaping, bounds, scroll retention, catalog conversation race/removal/selection",
  );
} finally {
  await browser?.close();
  await vite.close();
  rmSync(directory, { recursive: true, force: true });
}
