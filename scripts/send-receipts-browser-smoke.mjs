import assert from "node:assert/strict";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

// Real browser storage and locks, production receipt preparation/settlement,
// and an isolated idempotent HTTP fixture. No provider or live workspace IO.
const dir = await mkdtemp(join(tmpdir(), "loop-send-receipts-"));
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
let browser, server;
const effects = new Set();
let received = 0,
  dropReplies = true;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    [
      "import {prepareStoredSend,settleStoredSend,readSendReceipt,sendReceiptKey} from " +
        JSON.stringify(resolve("src/client/sendReceiptStore.ts")) +
        ";",
      'window.scope = sendReceiptKey("owner", "", "thread");',
      "window.prepare = prepareStoredSend;",
      "window.settle = settleStoredSend;",
      "window.ready = true;",
      "window.read = signature => readSendReceipt(localStorage, window.scope, signature);",
      "window.send = async signature => {",
      "  let sentKey; window.current = true;",
      '  const plan = await prepareStoredSend(localStorage, window.scope, signature, {signature:"",key:""}, {mode:"send",sendAt:null}, false, () => window.current, async prepared => {',
      "    sentKey = prepared.receipt.key;",
      "    queueMicrotask(() => { window.current = false; });",
      "    try {",
      '      await fetch("/send", {method:"POST",body:JSON.stringify(prepared.receipt)});',
      "      await settleStoredSend(localStorage, window.scope, prepared.receipt, null);",
      "    } catch {}",
      "  });",
      "  await plan?.completion;",
      '  if (window.current) throw new Error("post-lock view-change fixture did not run");',
      "  return sentKey;",
      "};",
    ].join("\n"),
  );
  const bundle = await browserFixtureBundle(entry);
  server = createServer(async (req, res) => {
    if (req.url === "/client.mjs") {
      res.setHeader("content-type", "text/javascript");
      res.end(bundle.script);
    } else if (req.url === "/send") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const receipt = JSON.parse(Buffer.concat(chunks).toString());
      received++;
      effects.add(receipt.key);
      if (dropReplies) req.socket.destroy();
      else res.end("{}");
    } else {
      res.setHeader("content-type", "text/html");
      res.end('<script type="module" src="/client.mjs"></script>');
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const context = await browser.newContext();
  const a = await context.newPage(),
    b = await context.newPage();
  const url = "http://127.0.0.1:" + server.address().port;
  for (const page of [a, b]) {
    await page.goto(url);
    await page.waitForFunction(() => window.ready);
  }

  // Queue both tabs behind the same real lock, then let them prepare together.
  await a.evaluate(() => {
    window.held = false;
    window.holding = navigator.locks.request(window.scope, async () => {
      window.held = true;
      await new Promise((resolve) => {
        window.release = resolve;
      });
    });
  });
  await a.waitForFunction(() => window.held);
  await Promise.all(
    [a, b].map((page) =>
      page.evaluate(() => {
        window.pending = window.send("same");
      }),
    ),
  );
  assert.equal(received, 0, "no dispatch while identity preparation is locked");
  await a.evaluate(() => window.release());
  const ids = await Promise.all(
    [a, b].map((page) => page.evaluate(() => window.pending)),
  );
  assert.equal(ids[0], ids[1], "concurrent sends reuse one pending identity");
  assert.equal(effects.size, 1);

  await b.evaluate(() => window.send("other"));
  await a.reload();
  await a.waitForFunction(() => window.ready);
  assert.equal(await a.evaluate(() => window.read("same").key), ids[0]);
  dropReplies = false;
  assert.equal(await a.evaluate(() => window.send("same")), ids[0]);
  assert.equal(effects.size, 2, "retry after a lost response adds no effect");
  assert.equal(await a.evaluate(() => window.read("same").key), "");
  assert.notEqual(await b.evaluate(() => window.read("other").key), "");

  // Abandon a scheduled send while another tab holds the preparation lock.
  await a.evaluate(() => {
    window.held = false;
    window.holding = navigator.locks.request(window.scope, async () => {
      window.held = true;
      await new Promise((resolve) => {
        window.release = resolve;
      });
    });
  });
  await a.waitForFunction(() => window.held);
  await b.evaluate(() => {
    window.current = true;
    window.abandoned = window.prepare(
      localStorage,
      window.scope,
      "abandoned",
      { signature: "", key: "" },
      { mode: "schedule", sendAt: 1000 },
      false,
      () => window.current,
    );
    window.current = false;
  });
  await a.evaluate(() => window.release());
  assert.equal(await b.evaluate(() => window.abandoned), null);
  assert.equal(await b.evaluate(() => window.read("abandoned").key), "");
  const fresh = await b.evaluate(() =>
    window.prepare(
      localStorage,
      window.scope,
      "abandoned",
      { signature: "", key: "" },
      { mode: "send", sendAt: null },
      false,
    ),
  );
  assert.deepEqual(fresh.intent, { mode: "send", sendAt: null });

  // Two tabs share an attempt; a refusal permits a new same-key schedule.
  for (const page of [a, b]) {
    await page.evaluate(async () => {
      window.oldAttempt = (
        await window.prepare(
          localStorage,
          window.scope,
          "late-refusal",
          { signature: "", key: "" },
          { mode: "send", sendAt: null },
          false,
        )
      ).receipt;
    });
  }
  await a.evaluate(async () => {
    await window.settle(localStorage, window.scope, window.oldAttempt, {
      ...window.oldAttempt,
      pending: false,
    });
    window.scheduled = (
      await window.prepare(
        localStorage,
        window.scope,
        "late-refusal",
        { signature: "", key: "" },
        { mode: "schedule", sendAt: 2000 },
        false,
      )
    ).receipt;
  });
  await b.evaluate(() =>
    window.settle(localStorage, window.scope, window.oldAttempt, {
      ...window.oldAttempt,
      pending: false,
    }),
  );
  const scheduled = await a.evaluate(() => window.scheduled);
  assert.equal(scheduled.key, await b.evaluate(() => window.oldAttempt.key));
  assert.notEqual(
    scheduled.attempt,
    await b.evaluate(() => window.oldAttempt.attempt),
  );
  await b.reload();
  await b.waitForFunction(() => window.ready);
  const retained = await b.evaluate(() =>
    window.prepare(
      localStorage,
      window.scope,
      "late-refusal",
      { signature: "", key: "" },
      { mode: "send", sendAt: null },
      false,
    ),
  );
  assert.deepEqual(retained.receipt, scheduled);

  const before = received;
  const error = await a.evaluate(async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    try {
      await window.send("quota");
      return "";
    } catch (error) {
      return error.message;
    } finally {
      Storage.prototype.setItem = original;
    }
  });
  assert.match(error, /nothing was sent/);
  assert.equal(received, before, "storage failure refuses dispatch");
  console.log(
    "send-receipts-browser (" +
      engine.name() +
      "): cross-tab identity, lost response, reload, independent settlement, abandoned schedule, stale refusal and storage refusal passed",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await rm(dir, { recursive: true, force: true });
}
