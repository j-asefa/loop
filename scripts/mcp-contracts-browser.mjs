import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { catalogJourney } from "./catalog-journey.mjs";
import {
  closeSheets,
  isolatedBrowserEnv,
  openSettings,
} from "./helpers/browser-ui.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { selectedEngines } from "./helpers/engines.mjs";

// Exercise the same SDK handshake and tool bridge as a third-party MCP app,
// bundled inline so the opaque sandbox never needs a network dependency.
const bundled = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
      import { App } from "@modelcontextprotocol/ext-apps";
      (async () => {
        const app = new App({ name: "Contract fixture", version: "1" }, {});
        const button = document.querySelector("button");
        const output = document.querySelector("output");
        try { void parent.document; document.querySelector("p").textContent = "Parent accessible"; }
        catch { document.querySelector("p").textContent = "Isolated from parent"; }
        app.ontoolresult = (result) => {
          document.querySelector("pre").textContent = JSON.stringify(result);
        };
        button.onclick = async () => {
          const result = await app.callServerTool({ name: "metrics", arguments: { query: "interactive" } });
          output.textContent = JSON.stringify(result);
        };
        await app.connect();
        button.disabled = false;
      })();`,
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
});
const appHtml = `<!doctype html><meta charset="utf-8"><title>Contract MCP app</title>
  <p>Checking isolation</p><pre></pre><button disabled>Request metrics</button><output></output>
  <script>${bundled.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`;
const evidence = process.env.LOOP_MCP_SCREENSHOT_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  let browser;
  try {
    browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium
          ? process.env.CHROMIUM_PATH || undefined
          : undefined,
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      // Playwright's blocker throws in opaque frames; use the real sandbox.
      serviceWorkers: "allow",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => {
      if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
        errors.push(error.message);
    });
    await catalogJourney(page, fixture.api, fixture.base);
    await openSettings(page);
    await page.getByRole("button", { name: /Tools & integrations/ }).click();
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page
      .getByRole("button", { name: "Add server URL", exact: true })
      .click();
    await page.getByLabel("Name", { exact: true }).fill("Contract MCP browser");
    await page
      .getByLabel("Server address", { exact: true })
      .fill("https://fixture.example/mcp");
    await page
      .getByRole("combobox", { name: /^Authentication/ })
      .selectOption("none");
    await page
      .getByRole("button", { name: "Connect & test", exact: true })
      .click();
    await expect(
      page.getByText("Connected. Available to all agents in your workspace.", {
        exact: true,
      }),
    ).toBeVisible();
    const connection = (await fixture.api("/mcp")).find(
      (item) => item.name === "Contract MCP browser",
    );
    assert.equal(connection.status, "connected");
    await page
      .getByRole("button", { name: "Permissions", exact: true })
      .click();
    for (const approvalMode of ["allow", "ask"]) {
      await page
        .getByLabel("Tool approvals", { exact: true })
        .selectOption(approvalMode);
      await expect
        .poll(async () => (await fixture.api("/mcp/preferences")).approvalMode)
        .toBe(approvalMode);
    }
    await closeSheets(page);

    // Seed through the production writer so the artifact and Cards projection
    // have the same capabilities/metadata as a result saved by the tool broker.
    const artifactId = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { readFileSync } from "node:fs";
      import { saveArtifact } from "./src/server/artifacts.ts";
      import { db } from "./src/server/db.ts";
      const { owner, data } = JSON.parse(readFileSync(0, "utf8"));
      process.stdout.write(saveArtifact(owner, data));
      db.close();
    `,
      ],
      {
        env: {
          ...(await isolatedBrowserEnv()),
          LOOP_DATA_DIR: dirname(fixture.db.name),
        },
        input: JSON.stringify({
          owner: fixture.owner,
          data: {
            title: "Contract MCP app",
            content: "Saved fixture snapshot",
            agent: fixture.agents[0].id,
            metadata: {
              connectionId: connection.id,
              tool: "metrics",
              arguments: { query: "stored source" },
              appResource: { html: appHtml },
              toolResult: {
                content: [{ type: "text", text: "Stored tool result" }],
              },
              fixture: true,
            },
          },
        }),
        encoding: "utf8",
      },
    ).trim();
    await page.goto(`${fixture.base}/?artifact=${artifactId}`);
    const iframe = page.getByTitle("MCP app, isolated from Loop", {
      exact: true,
    });
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    await expect(iframe).toHaveAttribute(
      "src",
      `/api/artifacts/${artifactId}/app`,
    );
    const frame = page.frameLocator(
      'iframe[title="MCP app, isolated from Loop"]',
    );
    await expect(
      frame.getByText("Isolated from parent", { exact: true }),
    ).toBeVisible();
    await expect(frame.locator("pre")).toContainText("Stored tool result");
    const callResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/artifacts/${artifactId}/tool-call` &&
        response.request().method() === "POST",
    );
    await frame
      .getByRole("button", { name: "Request metrics", exact: true })
      .click();
    const response = await callResponse;
    assert.equal(response.status(), 200);
    const run = await response.json();
    assert.equal(run.state, "queued");
    await expect(frame.locator("output")).toContainText(run.id);
    await expect(
      page.getByText("Tool request queued. Review it in Running.", {
        exact: true,
      }),
    ).toBeVisible();
    const request = response.request().postDataJSON();
    assert.equal(request.tool, "metrics");
    assert.deepEqual(request.arguments, { query: "interactive" });
    assert.match(request.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(run.payload).arguments, {
      query: "interactive",
    });
    assert.equal(JSON.parse(run.payload).connectionId, connection.id);

    await page.getByLabel("Result options", { exact: true }).click();
    const refreshResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/artifacts/${artifactId}/refresh` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Refresh from source", exact: true })
      .click();
    const refresh = await refreshResponse;
    assert.equal(refresh.status(), 200);
    const refreshRun = await refresh.json();
    assert.equal(refreshRun.state, "queued");
    assert.notEqual(refreshRun.id, run.id);
    assert.deepEqual(JSON.parse(refreshRun.payload).arguments, {
      query: "stored source",
    });
    await expect(
      page.getByText(
        "Refresh queued. Approve the request in Running; this snapshot stays saved.",
        { exact: true },
      ),
    ).toBeVisible();
    assert.equal(
      (await fixture.api(`/artifacts/${artifactId}`)).content,
      "Saved fixture snapshot",
    );
    if (evidence)
      await page.screenshot({
        path: join(evidence, `${engine.name()}-mcp-app.png`),
      });
    assert.deepEqual(errors, [], "Unexpected MCP browser errors");
    console.log(
      `${engine.name()}: catalog, manual connection, preferences, isolated MCP app/tool call and stored-source refresh passed (fixture MCP; no live provider or worker).`,
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
