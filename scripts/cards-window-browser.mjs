import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium, expect } from "@playwright/test";
// Uses the actual production hook, pager, source context and transport. Only
// HTTP responses are controlled to deliver old scopes after new ones.
const built = await build({
  entryPoints: ["test/fixtures/cards-window.tsx"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(built.outputFiles[0].text);
  } else {
    res.setHeader("content-type", "text/html");
    res.end(
      '<div id="root"></div><script type="module" src="/app.js"></script>',
    );
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
const entry = (text) => ({
  card: {
    id: "m:shared-id",
    type: "message",
    role: "user",
    content: text,
    format: "markdown",
    created_at: 1,
    updated_at: null,
    author: { kind: "owner", id: null, name: null, provider: null },
    recipient: null,
    source: {
      artifact_id: null,
      message_id: "shared-id",
      conversation_id: "thread",
      run_id: null,
    },
    context: {
      conversation_title: "Thread",
      folder_id: null,
      project_id: null,
      project_name: null,
      team_id: null,
    },
    attachments: [],
    saved: true,
    href: "/?conversation=thread",
  },
  order: [1, "m:shared-id"],
  saved: { at: 1, label: null },
});
try {
  for (const action of ["owner", "source", "filter"]) {
    const context = await browser.newContext(),
      page = await context.newPage();
    let release, committed, delivered;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const waiting = new Promise((resolve) => {
      committed = resolve;
    });
    const delivery = new Promise((resolve) => {
      delivered = resolve;
    });
    let first = true;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/changes"))
        return route.fulfill({
          json: { revision: "new", items: [], removed: [], more: false },
        });
      if (first) {
        first = false;
        committed();
        await held;
        await route.fulfill({
          json: {
            revision: "old",
            next: null,
            items: [entry("Old " + action)],
          },
        });
        delivered();
      } else
        await route.fulfill({
          json: {
            revision: "new",
            next: null,
            items: [entry("New " + action)],
          },
        });
    });
    await page.goto(origin);
    await waiting;
    await page
      .getByRole("button", { name: "Switch " + action, exact: true })
      .click();
    await expect(page.getByRole("listitem")).toHaveText("New " + action);
    release();
    await delivery;
    await expect(page.getByRole("listitem")).toHaveText("New " + action);
    await expect(page.getByText("Old " + action, { exact: true })).toHaveCount(
      0,
    );
    await context.close();
  }
  console.log(
    "Production card window discarded late owner, source and filter responses",
  );
  // Returning to the same source creates a new generation: an older request
  // must not clear the loading state of the new request with the same key.
  {
    const context = await browser.newContext(),
      page = await context.newPage();
    let releaseOld,
      releaseNew,
      startedOld,
      startedNew,
      deliveredOld,
      oldRequest;
    const oldHeld = new Promise((resolve) => {
      releaseOld = resolve;
    });
    const newHeld = new Promise((resolve) => {
      releaseNew = resolve;
    });
    const oldStarted = new Promise((resolve) => {
      startedOld = resolve;
    });
    const newStarted = new Promise((resolve) => {
      startedNew = resolve;
    });
    const oldDelivered = new Promise((resolve) => {
      deliveredOld = resolve;
    });
    let lists = 0;
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/changes"))
        return route.fulfill({
          json: { revision: "current", items: [], removed: [], more: false },
        });
      const request = ++lists;
      if (request === 1) {
        oldRequest = route.request();
        startedOld();
        await oldHeld;
      }
      if (request === 3) {
        startedNew();
        await newHeld;
      }
      await route.fulfill({
        json: {
          revision: "current",
          next: null,
          items: [entry("Request " + request)],
        },
      });
      if (request === 1) deliveredOld();
    });
    await page.goto(origin);
    await oldStarted;
    await page
      .getByRole("button", { name: "Switch source", exact: true })
      .click();
    await expect(page.getByRole("listitem")).toHaveText("Request 2");
    await page
      .getByRole("button", { name: "Return to source", exact: true })
      .click();
    await newStarted;
    await expect(page.getByRole("status")).toHaveText("Loading cards");
    // Source navigation may abort this request before the held response is
    // released. Observe its completion or cancellation, never a newer read.
    const response = oldRequest.response();
    releaseOld();
    await oldDelivered;
    const oldResponse = await response;
    if (oldResponse) await oldResponse.finished();
    else expect(oldRequest.failure()).toBeTruthy();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page.getByRole("status")).toHaveText("Loading cards");
    releaseNew();
    await expect(page.getByRole("listitem")).toHaveText("Request 3");
    await expect(page.getByRole("status")).toHaveCount(0);
    await context.close();
  }
  console.log("Returning to a source ignores its previous request generation");
  const context = await browser.newContext(),
    page = await context.newPage();
  let hold = false,
    release,
    started,
    releasePage,
    startedPage;
  let pages = 0;
  const pageHeld = new Promise((resolve) => {
    releasePage = resolve;
  });
  const pageWaiting = new Promise((resolve) => {
    startedPage = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/changes")) {
      if (hold) {
        started();
        await held;
      }
      await route.fulfill({
        json: { revision: "current", items: [], removed: [], more: false },
      });
    } else {
      pages++;
      if (new URL(route.request().url()).searchParams.has("before")) {
        startedPage();
        await pageHeld;
      }
      await route.fulfill({
        json: {
          revision: "current",
          next: pages === 1 ? "older" : null,
          items: [entry("Loaded card")],
        },
      });
    }
  });
  await page.goto(origin);
  await expect(page.getByRole("listitem")).toHaveText("Loaded card");
  await expect(page.getByRole("status")).toHaveCount(0);
  hold = true;
  await waiting;
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "More cards", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "More cards", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Loading cards");
  release();
  await pageWaiting;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.getByRole("status")).toHaveText("Loading cards");
  await expect(
    page.getByRole("button", { name: "More cards", exact: true }),
  ).toBeDisabled();
  releasePage();
  await expect(page.getByRole("status")).toHaveCount(0);
  if (pages !== 2)
    throw new Error(
      "One requested older page fetched " + (pages - 1) + " pages",
    );
  await context.close();
  console.log(
    "Background polling stays quiet while queued pagination remains loading",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
