import { build } from "esbuild";
import { expect } from "@playwright/test";

export async function statusPollingSmoke(browser, base) {
  const page = await browser.newPage();
  let healthyReads = 0,
    healthyResponses = 0;
  const hanging = [];
  try {
    page.on("response", (response) => {
      if (response.url().includes("/api/projects/status"))
        void response.finished().then(() => healthyResponses++);
    });
    await page.clock.install();
    await page.route("**/status-polling-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<main id="status-fixture"></main>',
      }),
    );
    await page.route("**/api/**", (route) => {
      if (route.request().url().includes("/agent-sources/")) {
        hanging.push(route);
        return;
      }
      return route.fulfill({
        json: {
          owner_id: "polling-owner",
          observed_at: Date.now(),
          teams: null,
          items: [
            {
              id: "healthy-project",
              name: `Healthy update ${++healthyReads}`,
              status: "idle",
              last_activity_at: Date.now(),
              older: false,
              counts: { needs: 0, working: 0, queued: 0 },
              actions: [],
              evidence: null,
              pulls: [],
              brief: {
                state: "never",
                headline: null,
                synthesized_at: null,
                pending: 0,
                unfinished: null,
                questions: null,
                blockers: null,
              },
            },
          ],
        },
      });
    });
    await page.goto(base + "/status-polling-fixture");
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: "tsx",
        contents: `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {ProjectStatusFeed} from './src/client/ProjectStatus';
          import {setViewOwner} from './src/client/viewCache';
          import {setShellSource} from './src/client/sourceRouting';
          setViewOwner('polling-owner'); setShellSource('');
          createRoot(document.getElementById('status-fixture')).render(
            <ProjectStatusFeed revision={0} onOpen={()=>{}} sources={[
              {id:'',name:'Healthy workspace'},
              {id:'docker:hanging',name:'Hanging workspace'},
            ]}/>
          );
        `,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"development"' },
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await expect.poll(() => hanging.length).toBeGreaterThan(0);
    await expect.poll(() => healthyResponses).toBe(healthyReads);
    await page.clock.runFor(16000);
    const title = page.getByRole("link", { name: /^Healthy update / });
    await expect(title).toHaveCount(1);
    await expect(page.getByText("Loading project status…")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      "Hanging workspace: Status unavailable.",
    );
    for (let index = 0; index < 2; index++) {
      const previous = await title.textContent();
      const previousReads = healthyReads;
      await page.clock.runFor(15000);
      await expect.poll(() => healthyReads).toBeGreaterThan(previousReads);
      // Let the real browser transport deliver the healthy response before
      // advancing the fake clock to the hanging source's timeout.
      await expect.poll(() => healthyResponses).toBe(healthyReads);
      await page.clock.runFor(15000);
      await expect(title).not.toHaveText(previous);
      await expect(page.locator(".status-live")).toHaveCount(1);
    }
  } finally {
    for (const route of hanging)
      await route.fulfill({ status: 503, json: {} }).catch(() => {});
    await page.close();
  }
}
