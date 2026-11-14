import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-selected-memory-"));
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
   import {NativeHistory} from ${JSON.stringify(resolve("src/client/NativeHistory.tsx"))};
   import {Memory,MemoryUsed} from ${JSON.stringify(resolve("src/client/Memory.tsx"))};
   import {ownerSession} from ${JSON.stringify(resolve("src/client/ownerSession.ts"))};
   import {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};
   ownerSession.change('alice');setShellSource('');
   function App(){
     const [receipt,setReceipt]=useState(false),[native,setNative]=useState(false),[run,setRun]=useState('run-one'),[,render]=useState(0);
     window.native=value=>flushSync(()=>setNative(value));
     window.receipt=value=>flushSync(()=>setReceipt(value));
     window.run=value=>flushSync(()=>setRun(value));
     window.source=value=>flushSync(()=>{setShellSource(value);render(n=>n+1)});
     window.owner=value=>flushSync(()=>{ownerSession.change(value);render(n=>n+1)});
     window.refresh=()=>window.dispatchEvent(new CustomEvent('loop-workspace-change'));
     return native?React.createElement(NativeHistory,{onClose:()=>{},onOpen:()=>{}}):receipt?React.createElement(MemoryUsed,{runId:run}):React.createElement(Memory,{folders:[],onClose:()=>{}});
   }
   createRoot(document.getElementById('root')).render(React.createElement(App));
 `,
  );
  const { script, style } = await browserFixtureBundle(entry);
  let hold = "",
    cooldown = false,
    revision = 1,
    label = "Server",
    failSave = false,
    failStatus = 0,
    fixtureOwner = "alice";
  const requests = [],
    closed = [];
  const summary = (id) => ({
    id,
    title: "Note " + id.toUpperCase(),
    kind: "note",
    project_id: null,
    revision,
    eligible: 1,
    tombstone: 0,
  });
  const document = (id) => ({
    ...summary(id),
    owner_id: fixtureOwner,
    source_id: id,
    conversation_id: null,
    message_id: null,
    agent_id: null,
    origin: "loop",
    role: "user-note",
    content_hash: "hash",
    content: label + " " + id,
    complete: 1,
    created_at: 1,
    updated_at: 1,
    truncated: false,
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/client.css"><div id="root"></div><script type="module" src="/client.mjs"></script>',
      );
      return;
    }
    if (url.pathname === "/client.mjs" || url.pathname === "/client.css") {
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".mjs")
          ? "text/javascript"
          : "text/css",
      });
      res.end(url.pathname.endsWith(".mjs") ? script : style);
      return;
    }
    const id = url.pathname.split("/").at(-1);
    const kind = url.pathname.endsWith("/native/history")
      ? "native-list"
      : url.pathname.includes("/native/history/")
        ? "native-detail"
        : url.pathname.endsWith("/memory") && !url.pathname.includes("/runs/")
          ? "status"
          : url.pathname.endsWith("/memory")
            ? "receipt"
            : req.method === "PATCH"
              ? "save"
              : "source";
    const request = { path: url.pathname, kind, id, method: req.method };
    requests.push(request);
    if (req.method === "PATCH") {
      let body = "";
      for await (const chunk of req) body += chunk;
      request.body = JSON.parse(body);
    }
    res.on("close", () => {
      if (!res.writableEnded) closed.push({ kind, id });
    });
    const retry = cooldown && (kind === "receipt" || kind === "native-detail");
    if (retry) cooldown = false;
    const body = retry
      ? { error: "Cooldown" }
      : kind === "native-list"
        ? {
            managed: [],
            external: [
              {
                id: "native-a",
                harness: "codex",
                title: "History A",
                project: "/fixture",
              },
              {
                id: "native-b",
                harness: "codex",
                title: "History B",
                project: "/fixture",
              },
            ],
            next: null,
          }
        : kind === "native-detail"
          ? { items: [], activities: [], note: label + " " + id }
          : kind === "status"
            ? {
                policies: [{ scope: "workspace", enabled: 1 }],
                sources: [summary("a"), summary("b")],
              }
            : kind === "receipt"
              ? {
                  mode: "lexical",
                  sources: JSON.stringify([
                    {
                      id: "source",
                      title: label,
                      link: "/?memory=a",
                      role: "user-note",
                      revision,
                    },
                  ]),
                  tokens: 10,
                  run_id: url.pathname.split("/").at(-2),
                  created_at: 1,
                }
              : kind === "save"
                ? failSave
                  ? { error: "Revision conflict" }
                  : { ok: true }
                : document(id);
    const transient = kind === "status" && failStatus > 0;
    if (transient) failStatus--;
    const failed = kind === "save" && failSave;
    const reply = () => {
      res.writeHead(retry ? 429 : transient ? 502 : failed ? 409 : 200, {
        "content-type": "application/json",
        ...(retry ? { "retry-after": "2" } : {}),
      });
      res.end(JSON.stringify(body));
    };
    if (hold === kind) {
      hold = "";
      held.push(reply);
    } else reply();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const engine = process.env.LOOP_BROWSER || "chromium";
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
  });
  const scenarios = ["draft", "scope", "receipt", "native"],
    selected = process.argv[2];
  assert(!selected || scenarios.includes(selected));
  for (const scenario of selected ? [selected] : scenarios) {
    label = "Server";
    fixtureOwner = "alice";
    revision = 1;
    failSave = false;
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    await expect(
      page.getByRole("button", { name: "Note A", exact: true }),
    ).toBeVisible();
    if (scenario === "draft") {
      hold = "source";
      await page.getByRole("button", { name: "Note A", exact: true }).click();
      await expect.poll(() => held.length).toBe(1);
      await page.getByRole("button", { name: "Note B", exact: true }).click();
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Note B",
      );
      held.splice(0).forEach((reply) => reply());
      await page.waitForTimeout(50);
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Note B",
      );
      await page
        .getByLabel("Note title", { exact: true })
        .fill("Unsaved title");
      await page
        .getByLabel("Note content", { exact: true })
        .fill("Unsaved content");
      label = "Changed remotely";
      revision = 2;
      const before = requests.length;
      await page.evaluate(() => window.refresh());
      await expect.poll(() => requests.length).toBeGreaterThan(before);
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Unsaved title",
      );
      await expect(
        page.getByLabel("Note content", { exact: true }),
      ).toHaveValue("Unsaved content");
      failSave = true;
      await page.getByRole("button", { name: "Save note revision" }).click();
      await expect(page.getByRole("alert")).toContainText("Revision conflict");
      await expect(
        page.getByLabel("Note content", { exact: true }),
      ).toHaveValue("Unsaved content");
      assert.equal(
        requests.filter((r) => r.kind === "save").at(-1).body.revision,
        1,
        "dirty revision is not silently rebased",
      );
      await page.getByRole("button", { name: "Close source" }).click();
      await page.getByRole("button", { name: "Note A", exact: true }).click();
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Note A",
      );
      failSave = false;
      hold = "save";
      await page.getByRole("button", { name: "Save note revision" }).click();
      await expect.poll(() => held.length).toBe(1);
      await page.getByRole("button", { name: "Note B", exact: true }).click();
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Note B",
      );
      held.splice(0).forEach((reply) => reply());
      await page.waitForTimeout(50);
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Note B",
      );
      await page.getByRole("button", { name: "Close source" }).click();
      await page.getByRole("button", { name: "Note A", exact: true }).click();
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Note A",
      );
      hold = "save";
      await page.getByRole("button", { name: "Save note revision" }).click();
      await expect.poll(() => held.length).toBe(1);
      await page.getByRole("button", { name: "Note B", exact: true }).click();
      await expect(page.getByLabel("Note title", { exact: true })).toHaveValue(
        "Note B",
      );
      const reread = page.waitForResponse(
        (response) =>
          response.url().endsWith("/memory/sources/a") &&
          response.request().method() === "GET",
      );
      await page.getByRole("button", { name: "Note A", exact: true }).click();
      await reread;
      label = "Saved";
      revision = 3;
      const statusBefore = requests.filter((r) => r.kind === "status").length;
      failStatus = 1;
      held.splice(0).forEach((reply) => reply());
      await expect(
        page.getByLabel("Note content", { exact: true }),
      ).toHaveValue("Saved a");
      await expect
        .poll(() => requests.filter((r) => r.kind === "status").length)
        .toBe(statusBefore + 2);
      await page.getByRole("button", { name: "Save note revision" }).click();
      await expect
        .poll(
          () => requests.filter((r) => r.kind === "save").at(-1).body.revision,
        )
        .toBe(3);
    } else if (scenario === "scope") {
      for (const kind of ["source", "owner"]) {
        await page.getByRole("button", { name: "Note A", exact: true }).click();
        await expect(
          page.getByLabel("Note title", { exact: true }),
        ).toHaveValue("Note A");
        await page
          .getByLabel("Note title", { exact: true })
          .fill("Private draft");
        if (kind === "owner") fixtureOwner = "bob";
        await page.evaluate(
          (k) => window[k](k === "source" ? "peer:other" : "bob"),
          kind,
        );
        await expect(
          page.getByLabel("Note title", { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Note A", exact: true }),
        ).toBeVisible();
      }
      hold = "source";
      await page.getByRole("button", { name: "Note B", exact: true }).click();
      await expect.poll(() => held.length).toBe(1);
      await page.getByRole("button", { name: "Close source" }).click();
      held.splice(0).forEach((reply) => reply());
      await page.waitForTimeout(50);
      await expect(page.getByLabel("Note title", { exact: true })).toHaveCount(
        0,
      );
    } else if (scenario === "native") {
      await page.evaluate(() => window.native(true));
      await page
        .getByRole("button", { name: "Other Codex", exact: true })
        .click();
      const a = page.getByRole("button", { name: /History A/ }),
        b = page.getByRole("button", { name: /History B/ });
      await expect(a).toBeVisible();
      assert(
        !requests.some((r) => r.kind === "native-detail"),
        "no detail request without selection",
      );
      const beforeClosed = closed.filter(
        (r) => r.kind === "native-detail",
      ).length;
      hold = "native-detail";
      await a.click();
      await expect.poll(() => held.length).toBe(1);
      await b.click();
      await expect(
        page.getByText("Server native-b", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => closed.filter((r) => r.kind === "native-detail").length)
        .toBeGreaterThan(beforeClosed);
      held.splice(0).forEach((reply) => reply());
      await page.waitForTimeout(50);
      await expect(
        page.getByText("Server native-a", { exact: true }),
      ).toHaveCount(0);
      for (const kind of ["source", "owner"]) {
        hold = "native-detail";
        await b.click();
        await expect.poll(() => held.length).toBe(1);
        await page.evaluate(
          (k) => window[k](k === "source" ? "peer:other" : "bob"),
          kind,
        );
        held.splice(0).forEach((reply) => reply());
        await expect(
          page.getByRole("button", {
            name: "Fork into a new Loop conversation",
            exact: true,
          }),
        ).toHaveCount(0);
        await page
          .getByRole("button", { name: "Other Codex", exact: true })
          .click();
        await expect(b).toBeVisible();
      }
      cooldown = true;
      const before = requests.filter((r) => r.kind === "native-detail").length;
      await a.click();
      await expect
        .poll(() => requests.filter((r) => r.kind === "native-detail").length)
        .toBe(before + 1);
      await page.evaluate(() => window.native(false));
      await page.waitForTimeout(2300);
      assert.equal(
        requests.filter((r) => r.kind === "native-detail").length,
        before + 1,
      );
    } else {
      await page.evaluate(() => window.receipt(true));
      const before = requests.filter((r) => r.kind === "receipt").length;
      await page.waitForTimeout(50);
      assert.equal(
        requests.filter((r) => r.kind === "receipt").length,
        before,
        "closed Memory used is idle",
      );
      hold = "receipt";
      await page.getByText("Memory used", { exact: true }).click();
      await expect.poll(() => held.length).toBe(1);
      await page.getByText("Memory used", { exact: true }).click();
      held.splice(0).forEach((reply) => reply());
      await page.waitForTimeout(50);
      await expect(
        page.getByRole("link", { name: "Server", exact: true }),
      ).toHaveCount(0);
      cooldown = true;
      const reads = requests.filter((r) => r.kind === "receipt").length;
      await page.getByText("Memory used", { exact: true }).click();
      await expect
        .poll(() => requests.filter((r) => r.kind === "receipt").length)
        .toBe(reads + 1);
      await page.getByText("Memory used", { exact: true }).click();
      await page.waitForTimeout(2300);
      assert.equal(
        requests.filter((r) => r.kind === "receipt").length,
        reads + 1,
        "closing cancels Retry-After",
      );
      label = "New run";
      await page.evaluate(() => window.run("run-two"));
      await page.getByText("Memory used", { exact: true }).click();
      await expect(
        page.getByRole("link", { name: "New run", exact: true }),
      ).toBeVisible();
    }
    console.log(engine + " selected-details " + scenario + ": passed");
    await page.close();
  }
} finally {
  held.splice(0).forEach((reply) => reply());
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await rm(dir, { recursive: true, force: true });
}
