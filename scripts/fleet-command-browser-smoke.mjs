// Real browser storage, Web Locks and the production typed client transport.
// The HTTP receipt server is a deterministic fixture, not a companion or a
// provider. Production gateway/destination admission is covered by HTTP tests.
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { browserFixtureBundle } from "./helpers/browser-fixture-bundle.mjs";

const dir = await mkdtemp(join(tmpdir(), "loop-fleet-client-browser-"));
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
const peer = "peer:m_" + "1".repeat(64);
const receipts = new Map();
const requests = [];
const missing = new Set();
let dropped = false,
  holdAuthorization = false,
  failAuthorization = false,
  authorizationStarted = false,
  releaseAuthorization,
  heldCommand,
  releaseAction,
  releaseRetry,
  releaseLookup,
  holdLookup = false,
  unknownLookup = false,
  browser,
  server,
  alternateServer;
try {
  const entry = join(dir, "entry.mjs");
  await writeFile(
    entry,
    [
      `import React from ${JSON.stringify(resolve("node_modules/react/index.js"))};`,
      `import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};`,
      `import {FleetCommandReceipts,showFleetCommandReceipts} from ${JSON.stringify(resolve("src/client/FleetCommandReceipts.tsx"))};`,
      `export {showFleetCommandReceipts};`,
      `import {setViewOwner as changeOwner} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};`,
      `export {loadCapabilities} from ${JSON.stringify(resolve("src/client/capabilities.ts"))};`,
      `export {callRoute,clearAuthorization,authorize} from ${JSON.stringify(resolve("src/client/api.ts"))};`,
      `export {pendingFleetCommands,reconcileFleetCommand} from ${JSON.stringify(resolve("src/client/fleetCommand.ts"))};`,
      `export {workspaceApi} from ${JSON.stringify(resolve("src/shared/workspace-api.ts"))};`,
      `export {setViewOwner} from ${JSON.stringify(resolve("src/client/viewCache.ts"))};`,
      `export {setShellSource} from ${JSON.stringify(resolve("src/client/sourceRouting.ts"))};`,
      `function ReceiptHarness({owner,hasPeer,showOnCommit,onMounted}) {React.useLayoutEffect(()=>{if(showOnCommit)showFleetCommandReceipts();onMounted();});return React.createElement(FleetCommandReceipts,{owner,sources:hasPeer?[{id:${JSON.stringify(peer)},name:"Remote fixture",kind:"peer"}]:[]});}`,
      `let root; export function renderReceipts(owner="fixture-owner", hasPeer=true, showOnCommit=false) {changeOwner(owner); root ??= createRoot(document.getElementById("root"));return new Promise(onMounted=>root.render(React.createElement(ReceiptHarness,{owner,hasPeer,showOnCommit,onMounted})));}`,
    ].join("\n"),
  );
  const { script, style: bundledStyle } = await browserFixtureBundle(entry);
  const style = await readFile(resolve("src/client/fleetCommandReceipts.css"));
  const serve = async (req, res) => {
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/") {
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-store",
      });
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated fleet command fixture</title><link rel="stylesheet" href="/receipts.css"><style>:root{--line:#999}body{font-family:system-ui;max-width:640px;margin:auto}textarea{box-sizing:border-box}</style><link rel="stylesheet" href="/client.css"><div id="root"></div>',
      );
      return;
    }
    if (req.url === "/receipts.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(style);
      return;
    }
    if (req.url === "/client.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(bundledStyle);
      return;
    }
    if (req.url === "/client.mjs") {
      res.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      res.end(script);
      return;
    }
    if (req.url === "/api/capabilities" && req.method === "GET") {
      reply(200, {
        pairedDevices: true,
      });
      return;
    }
    if (req.url === "/session") {
      if (holdAuthorization) {
        holdAuthorization = false;
        authorizationStarted = true;
        await new Promise((resolve) => {
          releaseAuthorization = resolve;
        });
      }
      if (failAuthorization) {
        failAuthorization = false;
        reply(503, { error: "Fixture authorization unavailable" });
        return;
      }
      reply(200, { csrf: "fixture-only" });
      return;
    }
    const lookup = req.url === "/api/fleet/commands/receipt";
    if (
      (!lookup &&
        !req.url?.startsWith(
          `/api/agent-sources/${encodeURIComponent(peer)}/native/decisions/`,
        )) ||
      req.method !== "POST" ||
      req.headers["x-loop-csrf"] !== "fixture-only"
    ) {
      reply(403, { error: "Fixture route refused" });
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (lookup) {
      assert.deepEqual(Object.keys(body).sort(), [
        "commandId",
        "payloadDigest",
        "peer",
        "route",
      ]);
      assert.equal(body.peer, peer.slice(5));
      assert.equal(body.route, "nativeAnswer");
      assert.match(body.payloadDigest, /^[a-f0-9]{64}$/);
      assert.equal(req.headers["x-loop-command-id"], undefined);
      requests.push({ id: body.commandId, query: true, path: req.url });
      if (holdLookup)
        await new Promise((resolve) => {
          releaseLookup = resolve;
        });
      if (!receipts.has(body.commandId)) missing.add(body.commandId);
      reply(200, {
        commandId: body.commandId,
        state:
          !unknownLookup && receipts.has(body.commandId)
            ? "completed"
            : "unknown",
        result: unknownLookup ? null : (receipts.get(body.commandId) ?? null),
      });
      return;
    }
    const id = req.headers["x-loop-command-id"],
      receiptOnly = req.headers["x-loop-receipt-only"] === "1",
      // Like the gateway's durable journal, a previously recorded identity can
      // only reconcile, even when the browser no longer has a pending entry.
      query = receiptOnly || receipts.has(id) || missing.has(id);
    assert.equal(body.commandId, id);
    requests.push({ id, query, receiptOnly, path: req.url });
    if (query && !receipts.has(id)) missing.add(id);
    if (!query && !missing.has(id) && !receipts.has(id))
      receipts.set(id, { state: "answered" });
    if (!dropped && !query) {
      dropped = true;
      // Deliver headers and a truncated body before closing. Browsers may
      // transparently retry a connection that vanished before any headers.
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": "1000",
      });
      res.flushHeaders();
      res.write('{"partial":');
      setTimeout(() => res.destroy(), 50);
      return;
    }
    if (!receipts.has(id)) {
      reply(503, {
        error: "Unknown fixture receipt",
        executionOutcome: "unknown",
      });
      return;
    }
    if (id === heldCommand)
      await new Promise((resolve) => {
        if (query) releaseRetry = resolve;
        else releaseAction = resolve;
      });
    reply(200, receipts.get(id), {
      "x-loop-command-id": id,
      "x-loop-command-state": "completed",
    });
  };
  server = createServer(serve);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await engine.launch({
    headless: true,
    ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  });
  const mobile = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  };
  const context = await browser.newContext(mobile);
  const first = await context.newPage();
  await first.goto(origin);
  async function send(page, decision, id) {
    return page.evaluate(
      async ({ peer, decision, id }) => {
        const api = await import("/client.mjs");
        api.setViewOwner("fixture-owner");
        api.setShellSource(peer);
        try {
          return {
            value: await api.callRoute(
              api.workspaceApi.nativeAnswer,
              {
                params: { id: decision },
                body: {
                  commandId: id,
                  answer: { message: "fixture-private-answer" },
                },
              },
              peer,
              AbortSignal.timeout(15_000),
            ),
          };
        } catch (error) {
          return { error: error.message };
        }
      },
      { peer, decision, id },
    );
  }
  const decision = randomUUID(),
    original = randomUUID();
  assert((await send(first, decision, original)).error);
  const retained = await first.evaluate(async () =>
    JSON.stringify(await (await import("/client.mjs")).pendingFleetCommands()),
  );
  assert(retained.includes(original));
  assert(!retained.includes("fixture-private-answer"));
  await first.reload();
  assert.deepEqual((await send(first, decision, randomUUID())).value, {
    state: "answered",
  });
  assert.deepEqual(
    requests.map(({ id, query }) => ({ id, query })),
    [
      { id: original, query: false },
      { id: original, query: true },
    ],
  );
  assert.equal(receipts.size, 1);
  assert.equal(requests[1].receiptOnly, true);
  const second = await context.newPage();
  await second.goto(origin);
  await second.evaluate(async () =>
    (await import("/client.mjs")).loadCapabilities(),
  );
  const holdPath = randomUUID(),
    preceding = requests.length;
  holdAuthorization = true;
  await first.evaluate(async () =>
    (await import("/client.mjs")).clearAuthorization(),
  );
  const sending = send(first, holdPath, randomUUID()).catch((error) => ({
    error: error.message,
  }));
  await expect.poll(() => authorizationStarted).toBe(true);
  const retrying = send(second, holdPath, randomUUID()).catch((error) => ({
    error: error.message,
  }));
  const checking = second
    .evaluate(async () => {
      const api = await import("/client.mjs");
      api.setViewOwner("fixture-owner");
      return api.reconcileFleetCommand((await api.pendingFleetCommands())[0]);
    })
    .catch((error) => ({ error: error.message }));
  try {
    await second.waitForTimeout(300);
    assert.equal(
      requests.length,
      preceding,
      "A second tab must not overtake an original send awaiting authorization",
    );
  } finally {
    releaseAuthorization();
  }
  const results = await Promise.all([sending, retrying]);
  const priorLookup = await checking;
  assert(
    priorLookup.state === "completed" ||
      priorLookup.error?.includes("no longer pending"),
  );
  assert(results.every((result) => result.value?.state === "answered"));
  const concurrent = requests.filter((request) =>
    request.path.endsWith(holdPath),
  );
  assert.equal(concurrent.filter((request) => !request.query).length, 1);
  assert.equal(new Set(concurrent.map((request) => request.id)).size, 1);
  assert.equal(receipts.size, 2);
  dropped = false;
  const withoutBody = randomUUID();
  assert((await send(first, randomUUID(), withoutBody)).error);
  await first.reload();
  const checked = await first.evaluate(async () => {
    const api = await import("/client.mjs");
    api.setShellSource("");
    await api.loadCapabilities();
    api.setViewOwner("fixture-owner");
    const [pending] = await api.pendingFleetCommands();
    const receipt = await api.reconcileFleetCommand(
      pending,
      AbortSignal.timeout(15_000),
    );
    return { receipt, pending: await api.pendingFleetCommands() };
  });
  assert.deepEqual(checked, {
    receipt: {
      commandId: withoutBody,
      state: "completed",
      result: { state: "answered" },
    },
    pending: [],
  });
  assert.equal(requests.at(-1).path, "/api/fleet/commands/receipt");
  assert.equal(
    requests.filter((request) => request.id === withoutBody && !request.query)
      .length,
    1,
  );
  assert.equal(receipts.size, 3);
  // A queued retry and bodyless lookup must not reserve an absent receipt
  // when the first sender fails authorization before its action fetch.
  const unsentDecision = randomUUID(),
    unsentId = randomUUID();
  holdAuthorization = true;
  failAuthorization = true;
  authorizationStarted = false;
  await first.evaluate(async () =>
    (await import("/client.mjs")).clearAuthorization(),
  );
  const failed = send(first, unsentDecision, unsentId).catch((error) => ({
    error: error.message,
  }));
  await expect.poll(() => authorizationStarted).toBe(true);
  const recoveredSend = send(second, unsentDecision, unsentId).catch(
    (error) => ({ error: error.message }),
  );
  await expect
    .poll(() =>
      second.evaluate(
        async (id) =>
          (await navigator.locks.query()).pending.some((lock) =>
            lock.name.endsWith(":command:" + id),
          ),
        unsentId,
      ),
    )
    .toBe(true);
  const staleLookup = second.evaluate(async () => {
    const api = await import("/client.mjs");
    try {
      return await api.reconcileFleetCommand(
        (await api.pendingFleetCommands())[0],
      );
    } catch (error) {
      return { error: error.message };
    }
  });
  await expect
    .poll(() =>
      second.evaluate(
        async (id) =>
          (await navigator.locks.query()).pending.filter((lock) =>
            lock.name.endsWith(":command:" + id),
          ).length,
        unsentId,
      ),
    )
    .toBe(2);
  releaseAuthorization();
  assert((await failed).error);
  assert.equal(
    (await recoveredSend).value?.state,
    "answered",
    "A queued retry must execute an intent that never reached action transport",
  );
  assert((await staleLookup).error?.includes("no longer pending"));
  const recoveredRequests = requests.filter(
    (request) => request.id === unsentId,
  );
  assert.equal(
    recoveredRequests.length,
    1,
    "No queued lookup may poison an absent receipt",
  );
  assert.equal(recoveredRequests[0].receiptOnly, false);
  assert.equal(receipts.size, 4);
  const beforeOverlap = receipts.size;
  // A completed sender can clear its journal while a queued receipt retry
  // still owns the command lock. A third explicit-ID retry must not hold the
  // journal lock while waiting for that command, or it also blocks unrelated IO.
  const overlapDecision = randomUUID(),
    overlapId = randomUUID();
  heldCommand = overlapId;
  const initial = send(first, overlapDecision, overlapId).catch((error) => ({
    error: error.message,
  }));
  await expect.poll(() => typeof releaseAction).toBe("function");
  const queued = send(second, overlapDecision, overlapId).catch((error) => ({
    error: error.message,
  }));
  await expect
    .poll(() =>
      second.evaluate(
        async (id) =>
          (await navigator.locks.query()).pending.some((lock) =>
            lock.name.endsWith(":command:" + id),
          ),
        overlapId,
      ),
    )
    .toBe(true);
  releaseAction();
  assert.equal((await initial).value?.state, "answered");
  await expect.poll(() => typeof releaseRetry).toBe("function");
  const late = send(first, overlapDecision, overlapId).catch((error) => ({
    error: error.message,
  }));
  await expect
    .poll(() =>
      first.evaluate(
        async (id) =>
          (await navigator.locks.query()).pending.some((lock) =>
            lock.name.endsWith(":command:" + id),
          ),
        overlapId,
      ),
    )
    .toBe(true);
  const unrelatedId = randomUUID();
  const unrelated = send(second, randomUUID(), unrelatedId).catch((error) => ({
    error: error.message,
  }));
  try {
    await expect
      .poll(() => requests.some((request) => request.id === unrelatedId), {
        message:
          "A waiting explicit-ID retry must release the journal for unrelated commands",
      })
      .toBe(true);
    assert.equal((await unrelated).value?.state, "answered");
  } finally {
    heldCommand = undefined;
    releaseRetry();
  }
  assert(
    (await Promise.all([queued, late])).every(
      (result) => result.value?.state === "answered",
    ),
  );
  assert.equal(receipts.size, beforeOverlap + 2);
  // A cancelled caller must release its command even if shared authorization
  // stays stalled. Another already-authorized tab can then send the unsent ID.
  const cancelledDecision = randomUUID(),
    cancelledId = randomUUID();
  holdAuthorization = true;
  authorizationStarted = false;
  await first.evaluate(
    async ({ peer, decision, id }) => {
      const api = await import("/client.mjs");
      api.clearAuthorization();
      window.authorizationAbort = new AbortController();
      window.cancelledAuthorization = undefined;
      void api
        .callRoute(
          api.workspaceApi.nativeAnswer,
          {
            params: { id: decision },
            body: {
              commandId: id,
              answer: { message: "fixture-private-answer" },
            },
          },
          peer,
          window.authorizationAbort.signal,
        )
        .then(
          (value) => {
            window.cancelledAuthorization = { value };
          },
          (error) => {
            window.cancelledAuthorization = {
              error: error.message,
              outcome: error.executionOutcome,
            };
          },
        );
    },
    { peer, decision: cancelledDecision, id: cancelledId },
  );
  await expect.poll(() => authorizationStarted).toBe(true);
  const afterAbort = send(second, cancelledDecision, cancelledId).catch(
    (error) => ({ error: error.message }),
  );
  try {
    await expect
      .poll(() =>
        second.evaluate(
          async (id) =>
            (await navigator.locks.query()).pending.some((lock) =>
              lock.name.endsWith(":command:" + id),
            ),
          cancelledId,
        ),
      )
      .toBe(true);
    await first.evaluate(() => window.authorizationAbort.abort());
    await expect
      .poll(() => first.evaluate(() => window.cancelledAuthorization?.outcome))
      .toBe("not_sent");
    assert.equal((await afterAbort).value?.state, "answered");
  } finally {
    releaseAuthorization();
  }
  await first.evaluate(async () => (await import("/client.mjs")).authorize());
  const afterAbortRequests = requests.filter(
    (request) => request.id === cancelledId,
  );
  assert.equal(afterAbortRequests.length, 1);
  assert.equal(afterAbortRequests[0].receiptOnly, false);
  assert.equal(missing.has(cancelledId), false);
  dropped = false;
  const beforeTransfer = receipts.size;
  const transferred = randomUUID();
  assert((await send(first, randomUUID(), transferred)).error);
  await first.reload();
  async function mount(page) {
    await page.bringToFront();
    await page.evaluate(async () => {
      const api = await import("/client.mjs");
      api.setShellSource("");
      await api.loadCapabilities();
      api.renderReceipts();
    });
    await page.getByText(/^Actions to check/).click();
  }
  await mount(first);
  await expect(
    first.getByText("Actions to check (1)", { exact: true }),
  ).toBeVisible();
  await first.getByRole("button", { name: "Show receipt to copy" }).click();
  const packet = await first
    .getByLabel("Receipt to copy", { exact: true })
    .inputValue();
  assert(packet.includes(transferred));
  assert(!packet.includes("fixture-private-answer"));
  assert(!packet.includes("fixture-owner"));
  alternateServer = createServer(serve);
  await new Promise((resolve) =>
    alternateServer.listen(0, "127.0.0.1", resolve),
  );
  const recovered = await (await browser.newContext(mobile)).newPage();
  await recovered.goto(`http://localhost:${alternateServer.address().port}`);
  await mount(recovered);
  await expect(
    recovered.getByText("No actions are waiting for a receipt here."),
  ).toBeVisible();
  const count = requests.length;
  await recovered.getByLabel("Receipt from another gateway").fill(packet);
  await recovered.getByRole("button", { name: "Keep receipt" }).click();
  await expect(recovered.getByRole("status")).toContainText("Receipt retained");
  await recovered.screenshot({
    path: `/tmp/loop-fleet-receipt-ui-${engine.name()}.png`,
    fullPage: true,
  });
  assert.equal(requests.length, count);
  unknownLookup = true;
  await recovered.getByRole("button", { name: "Check outcome" }).click();
  await expect(recovered.getByRole("status")).toContainText("unknown outcome");
  await expect(
    recovered.getByText("Actions to check (1)", { exact: true }),
  ).toBeVisible();
  unknownLookup = false;
  holdLookup = true;
  const beforeHeld = requests.length;
  await recovered.getByRole("button", { name: "Check outcome" }).click();
  await expect.poll(() => requests.length).toBe(beforeHeld + 1);
  await recovered.evaluate(async () =>
    (await import("/client.mjs")).renderReceipts("unrelated-owner"),
  );
  await expect(recovered.locator(".fleet-command-receipts li")).toHaveCount(0);
  releaseLookup();
  holdLookup = false;
  await recovered.getByText(/^Actions to check/).click();
  await expect(recovered.getByRole("status")).toHaveCount(0);
  await recovered.evaluate(async () =>
    (await import("/client.mjs")).renderReceipts(),
  );
  await recovered.getByText(/^Actions to check/).click();
  await expect(
    recovered.getByText("Actions to check (1)", { exact: true }),
  ).toBeVisible();
  await recovered.getByRole("button", { name: "Check outcome" }).click();
  await expect(recovered.getByRole("status")).toContainText("completed");
  await expect(recovered.locator(".fleet-command-receipts li")).toHaveCount(0);
  assert.equal(
    requests.filter((request) => request.id === transferred && !request.query)
      .length,
    1,
  );
  assert.equal(receipts.size, beforeTransfer + 1);
  // The original origin keeps its reference until it independently checks the
  // outcome. A receipt never pretends storage/cookies are shared across origins.
  await first.bringToFront();
  await expect(
    first.getByText("Actions to check (1)", { exact: true }),
  ).toBeVisible();
  await first.getByRole("button", { name: "Check outcome" }).click();
  await expect(first.getByRole("status")).toContainText("completed");
  await expect(first.locator(".fleet-command-receipts li")).toHaveCount(0);
  await recovered.bringToFront();
  await recovered.evaluate(async () =>
    (await import("/client.mjs")).renderReceipts("standalone-owner", false),
  );
  await expect(recovered.locator(".fleet-command-receipts")).toHaveCount(0);
  await recovered.evaluate(async () =>
    (await import("/client.mjs")).showFleetCommandReceipts(),
  );
  await expect(
    recovered.getByLabel("Receipt from another gateway", { exact: true }),
  ).toBeVisible();
  // An imperative request in the new owner's mount commit must reach the
  // mounted panel before passive effects run.
  await recovered.evaluate(async () =>
    (await import("/client.mjs")).renderReceipts("commit-owner", false, true),
  );
  await expect(
    recovered.getByLabel("Receipt from another gateway", { exact: true }),
  ).toBeVisible();
  const beforeStorageFailure = requests.length;
  await first.evaluate(() => {
    window.savedOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = () => {
      throw new Error("Fixture database unavailable");
    };
  });
  try {
    assert(
      (await send(first, randomUUID(), randomUUID())).error.includes(
        "retained safely",
      ),
    );
    assert.equal(requests.length, beforeStorageFailure);
  } finally {
    await first.evaluate(() => {
      IDBFactory.prototype.open = window.savedOpen;
    });
  }
  console.log(
    `PASS (${engine.name()}): lost responses and reloads reconcile one command; two tabs and bodyless lookup cannot overtake the first send during authorization; receipt queries never submit an absent command; overlapping explicit-ID retries release the journal so other commands can progress; queued retries recover authorization failures without querying absent receipts; the visible panel transfers receipts across separate origins without action submission, retains uncertainty and rejects stale-owner results. Deterministic HTTP fixture.`,
  );
} finally {
  releaseAuthorization?.();
  releaseAction?.();
  releaseRetry?.();
  releaseLookup?.();
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (alternateServer) {
    alternateServer.closeAllConnections();
    await new Promise((resolve) => alternateServer.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
