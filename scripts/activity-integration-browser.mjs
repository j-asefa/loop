// Deterministic HTTP backend + production conversation/history components.
// This exercises browser integration, not a live native-agent/provider call.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import {
  reduceActivity,
  undiscoveredCapabilities,
} from "../src/agent-activities.ts";
const source = {
  transport: "native",
  harness: "fixture",
  origin: "deterministic-browser",
};
const record = (kind, id, patch) =>
  reduceActivity(undefined, { v: 1, source, kind, id, patch }).record;
const attack = '<img src=x onerror="globalThis.pwned=true">';
const initialRecords = () => [
  record("plan", "p", {
    steps: [{ id: "one", title: "Inspect " + attack, status: "in_progress" }],
  }),
  record("file_change", "f", {
    state: "proposed",
    files: [
      {
        path: "../../" + attack,
        operation: "rename",
        oldPath: "old.ts",
        patch: "-old\n+new " + attack,
      },
    ],
  }),
  record("output", "o", {
    replace: [
      {
        stream: "combined",
        text:
          Array.from({ length: 5000 }, (_, i) => `${i} output\n`).join("") +
          attack,
      },
    ],
    status: "running",
  }),
];
let records = initialRecords();
let complete = false,
  revision = 1,
  model = "a",
  removed = false,
  reject = false,
  writes = 0;
const capabilities = undiscoveredCapabilities("Deterministic backend fixture");
for (const value of Object.values(capabilities)) value.state = "supported";
function controls() {
  return {
    generation: "g",
    settings: {
      revision,
      options: [
        {
          id: "model",
          label: "Session model",
          type: "select",
          choices: [
            { value: "a", label: "Model A" },
            { value: "b", label: "Model B" },
          ],
          confirmed: model,
          mutable: true,
          application: "live",
          provenance: "fixture runtime",
        },
        ...(model === "a"
          ? [
              {
                id: "effort",
                label: "Dependent effort",
                type: "select",
                choices: [{ value: "high", label: "High" }],
                confirmed: "high",
                mutable: true,
                application: "next-turn",
              },
            ]
          : []),
      ],
    },
    capabilities,
  };
}
const decisions = () =>
  complete
    ? []
    : [
        {
          id: "permission",
          conversation_id: "conversation",
          name: "Fixture",
          state: "pending",
          request: JSON.stringify({
            id: "permission",
            kind: "approval",
            title: "Approve fixture command",
            detail: "echo safe",
            choices: ["allow", "deny"],
          }),
        },
      ];
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "activity-http-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://fixture");
          if (url.pathname === "/activity-integration") {
            res.setHeader("content-type", "text/html");
            res.end(readFileSync("tests/fixtures/activity-ui/index.html"));
            return;
          }
          if (!url.pathname.startsWith("/api/") && url.pathname != "/session")
            return next();
          let body = "";
          for await (const chunk of req) body += chunk;
          let result;
          if (url.pathname === "/session") result = { csrf: "fixture" };
          else if (url.pathname === "/api/capabilities")
            result = {
              profile: "companion",
              nativeHarnesses: true,
              pairedDevices: true,
              runtimeHosts: false,
              localProjects: true,
            };
          else if (
            url.pathname === "/api/conversations/conversation/activities"
          )
            result = {
              version: 1,
              cursor: complete ? 2 : 1,
              more: false,
              items: records.map((record) => ({
                key: record.kind + ":" + record.id,
                kind: record.kind,
                run: "run",
                sequence: complete ? 2 : 1,
                record,
              })),
            };
          else if (url.pathname === "/api/conversations/conversation")
            result = {
              conversation: {
                id: "conversation",
                agent_id: "agent",
                title: "Integrated activities",
                origin: "native",
              },
              messages: [
                {
                  id: "answer",
                  role: "assistant",
                  content: complete ? "Finished fixture" : "Working fixture",
                  run_id: "run",
                  run_state: complete ? "completed" : "running",
                  metadata: "{}",
                  cursor: [1, 1, 1],
                },
              ],
              next: null,
              activities: records.map((record) => ({ record, run_id: "run" })),
            };
          else if (url.pathname === "/api/conversations/conversation/settings")
            result = controls();
          else if (
            url.pathname.startsWith(
              "/api/conversations/conversation/settings/",
            ) &&
            req.method === "PATCH"
          ) {
            const input = JSON.parse(body);
            writes++;
            await new Promise((r) => setTimeout(r, 250));
            if (reject || input.revision !== revision) {
              res.statusCode = 409;
              result = {
                error: reject
                  ? "Fixture runtime rejected model"
                  : "Stale settings revision",
              };
            } else {
              model = input.value;
              revision++;
              result = controls();
            }
          } else if (url.pathname === "/api/agents/agent/harness")
            result = {
              available: true,
              runtime: "fixture",
              revision: removed ? 2 : 1,
              commands: removed
                ? []
                : [
                    {
                      name: "inspect",
                      token: "/inspect",
                      kind: "command",
                      description: "Inspect fixture",
                      argumentHint: "path",
                    },
                  ],
            };
          else if (url.pathname === "/api/native/decisions")
            result = decisions();
          else if (url.pathname === "/api/native/history")
            result = {
              managed: [],
              external: [
                {
                  id: "external",
                  title: "Completed fixture history",
                  harness: "codex",
                  project: "/fixture",
                },
              ],
            };
          else if (url.pathname === "/api/native/history/external")
            result = {
              items: [],
              activities: records,
              note: "Deterministic persisted history response",
            };
          else if (url.pathname === "/api/fixture") {
            const input = JSON.parse(body);
            if (input.complete) {
              complete = true;
              records[0] = record("plan", "p", {
                steps: [
                  {
                    id: "one",
                    title: "Inspect " + attack,
                    status: "completed",
                  },
                ],
              });
              records[2] = record("output", "o", {
                replace: [{ stream: "combined", text: "final " + attack }],
                status: "exited",
                exitCode: 0,
              });
            }
            if (input.removed) removed = true;
            if (input.reject !== undefined) reject = input.reject;
            result = { ok: true };
          } else result = [];
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
        });
      },
    },
  ],
});
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
    headless: true,
  });
  mkdirSync(".tmp", { recursive: true });
  for (const width of [390, 1280]) {
    complete = false;
    model = "a";
    revision = 1;
    removed = false;
    reject = false;
    writes = 0;
    records = initialRecords();
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    page.on("requestfailed", (r) =>
      console.error("requestfailed", r.url(), r.failure()?.errorText),
    );
    page.setDefaultTimeout(12000);
    await page.goto(base + "/activity-integration", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await expect(
      page.getByRole("heading", { name: /Command output/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Approve fixture command", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Approve fixture command", { exact: true }),
    ).toBeVisible();
    assert.equal(await page.locator("img[src=x]").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const output = page.getByLabel("Scrollable command output");
    await output.evaluate((e) => {
      e.scrollTop = 0;
      e.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(
      page.getByRole("button", { name: "Follow latest output" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Follow latest output" }).click();
    await page.getByLabel("Conversation options").click();
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await expect(page.getByLabel("Session model")).toHaveValue("a");
    await page.getByLabel("Session model").selectOption("b");
    await expect(page.getByText(/Requested: b/)).toBeVisible();
    await expect(page.getByText("Confirmed: a", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Session model")).toHaveValue("b");
    await expect(page.getByLabel("Dependent effort")).toHaveCount(0);
    await page.request.post(base + "/api/fixture", { data: { reject: true } });
    await page.getByLabel("Session model").selectOption("a");
    await expect(
      page.getByText("Fixture runtime rejected model"),
    ).toBeVisible();
    await expect(page.getByLabel("Session model")).toHaveValue("b");
    assert.equal(writes, 2);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Commands & skills", exact: true })
      .click();
    await expect(page.getByRole("button", { name: /\/inspect/ })).toBeVisible();
    await page.request.post(base + "/api/fixture", { data: { removed: true } });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect(page.getByRole("button", { name: /\/inspect/ })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    await page.request.post(base + "/api/fixture", {
      data: { complete: true },
    });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("loop-workspace-change")),
    );
    await expect(page.getByText("1 of 1 complete")).toBeVisible();
    await expect(page.getByText("Exit code: 0")).toBeVisible();
    await page.reload();
    await expect(page.getByText("1 of 1 complete")).toBeVisible();
    await page.screenshot({
      path: `.tmp/activity-conversation-${width}.png`,
      fullPage: true,
    });
    await page.goto(base + "/activity-integration?history");
    await page
      .getByRole("button", { name: /Completed fixture history/ })
      .click();
    await expect(page.getByText("1 of 1 complete")).toBeVisible();
    assert.equal(await page.locator("img[src=x]").count(), 0);
    await page.screenshot({
      path: `.tmp/activity-history-${width}.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "PASS actual Conversation/NativeHistory HTTP fixtures at 390/1280: live, reload, pending approval, settings pending/confirmed/rejected/dependent removal, catalog removal, completed history, hostile text, scroll bounds. No real agent calls.",
  );
} finally {
  await browser?.close();
  await vite.close();
}
