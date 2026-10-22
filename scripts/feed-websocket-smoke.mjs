import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit, expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

function seed({ db, owner }, label, history = 55, activeHistory = 45) {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO agents(id,owner_id,name,normalized_name,provider,model,created_at) VALUES('agent',?,?,?,'openai','fixture',?)",
    ).run(owner, label, label.toLowerCase(), now);
    db.prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES('thread',?,'agent',?,?)",
    ).run(owner, label + " task", now);
    const run = db.prepare(
      "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,'agent','thread','Prompt',?,?,?,?)",
    );
    const message = db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES(?,?,'thread',?,'assistant',?,'{}',?)",
    );
    for (let n = 0; n < history; n++) {
      const at = now - 100_000 + n;
      run.run("old-" + n, owner, "completed", "old-" + n, at, at);
      message.run(
        "answer-" + n,
        owner,
        "old-" + n,
        label + " history " + n,
        at,
      );
    }
    run.run("live", owner, "running", "live", now, now);
    db.prepare("UPDATE runs SET input=?").run(label + " task");
    for (let n = 0; n < activeHistory; n++) {
      const id = "active-" + n;
      const title = label + " earlier task " + n;
      const at = now - 10_000 + n;
      db.prepare(
        "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,'agent',?,?)",
      ).run(id, owner, title, at);
      db.prepare(
        "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,created_at,updated_at) VALUES(?,?,'agent',?,?,'running',?,?,?)",
      ).run(id, owner, id, title, id, at, at);
    }
    const event = db.prepare(
      "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'old-0','delta','{}',?)",
    );
    for (let n = 0; n < 1000; n++) event.run(owner, now - 1000 + n);
  }).immediate();
}
function complete({ db, owner }, label) {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "UPDATE runs SET state='completed',updated_at=? WHERE id='live'",
    ).run(now);
    db.prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) VALUES('live-answer',?,'thread','live','assistant',?,'{}',?)",
    ).run(owner, label + " live final answer", now);
  }).immediate();
}
const engines = process.env.LOOP_BROWSER
  ? [process.env.LOOP_BROWSER]
  : ["chromium", "webkit"];
for (const engine of engines) {
  const browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(engine === "chromium"
      ? {
          args: ["--no-sandbox"],
          executablePath: process.env.CHROMIUM_PATH || undefined,
        }
      : {}),
  });
  try {
    for (const mode of ["server", "companion"]) {
      let fixture, remote, context, dockerDir;
      const priorPath = process.env.PATH;
      try {
        if (mode === "companion") {
          remote = await cardsFixture("server", true);
          seed(remote, "Remote", 2, 0);
          // Fixture discovery, real source servers and real gateway forwarding.
          dockerDir = mkdtempSync(join(tmpdir(), "loop-events-docker-"));
          const id = "a".repeat(64);
          writeFileSync(
            join(dockerDir, "inspect.json"),
            JSON.stringify([
              {
                Id: id,
                Config: {
                  Labels: {
                    "com.docker.compose.project": "events-fixture",
                    "com.docker.compose.service": "app",
                  },
                },
                State: { Running: true },
                NetworkSettings: {
                  Ports: {
                    "3000/tcp": [
                      {
                        HostIp: "127.0.0.1",
                        HostPort: new URL(remote.origin).port,
                      },
                    ],
                  },
                },
              },
            ]),
          );
          writeFileSync(
            join(dockerDir, "docker"),
            `#!/bin/sh\nif [ "$1" = ps ]; then printf '%s\\n' '${id}'; else cat '${dockerDir}/inspect.json'; fi\n`,
            { mode: 0o755 },
          );
          process.env.PATH = dockerDir + ":" + priorPath;
        }
        fixture = await cardsFixture(mode, true);
        process.env.PATH = priorPath;
        seed(fixture, "Local");
        context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          serviceWorkers: "block",
        });
        let blockSockets = false;
        // Install interception before pages capture their WebSocket constructor.
        await context.routeWebSocket(
          (url) =>
            url.pathname === "/ws" || url.pathname.endsWith("/events/ws"),
          (socket) => {
            if (blockSockets) socket.close();
            else socket.connectToServer();
          },
        );
        if (fixture.browser.cookie) {
          const [name, value] = fixture.browser.cookie.split("=");
          await context.addCookies([
            {
              name,
              value,
              url: fixture.origin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]);
        }
        await context.addInitScript(() => {
          const Original = window.WebSocket;
          window.__eventSockets = [];
          window.__workspaceUpdates = 0;
          window.WebSocket = class extends Original {
            constructor(...args) {
              super(...args);
              window.__eventSockets.push(this);
              this.addEventListener("message", (event) => {
                const frame = JSON.parse(event.data);
                if (frame.v === 2) this.__eventCursor = frame.cursor;
              });
            }
          };
          window.addEventListener(
            "loop-workspace-change",
            () => window.__workspaceUpdates++,
          );
        });
        // Passing this journey requires push: HTTP event polling cannot help.
        await context.route(
          /\/api\/(?:agent-sources\/[^/]+\/)?events\?/,
          (route) => route.abort(),
        );
        const working = await context.newPage(),
          done = await context.newPage();
        const errors = [];
        for (const page of [working, done])
          page.on("pageerror", (e) => {
            if (!isWebKitNavigationFetchError(engine, e, fixture.origin))
              errors.push(e.message);
          });
        await working.goto(fixture.origin + "/?filter=working");
        const row = (page, text) =>
          page.locator(".inbox-results .inbox-card").filter({ hasText: text });
        await expect(row(working, "Local task"))
          .toHaveCount(1)
          .catch(async (error) => {
            console.error(await working.locator("body").innerText());
            console.error(
              await (
                await fixture.request("/api/feed?filter=working", {
                  headers: fixture.browser,
                })
              ).text(),
            );
            throw error;
          });
        if (remote) {
          await expect(row(working, "Remote task")).toHaveCount(1);
          const localSockets = () =>
            working.evaluate(
              () =>
                window.__eventSockets.filter(
                  (socket) => new URL(socket.url).pathname === "/ws",
                ).length,
            );
          await expect.poll(localSockets).toBe(1);
          // A source disappearing and returning must only replace its own
          // watcher. Keep the healthy local socket, cursor and build baseline.
          await working.route("**/api/agent-sources", (route) =>
            route.fulfill({ json: [] }),
          );
          await working.evaluate(() =>
            window.dispatchEvent(new Event("loop-source-refresh")),
          );
          await expect
            .poll(() =>
              working.evaluate(() =>
                window.__eventSockets
                  .filter((socket) => new URL(socket.url).pathname !== "/ws")
                  .every((socket) => socket.readyState === WebSocket.CLOSED),
              ),
            )
            .toBe(true);
          assert.equal(await localSockets(), 1);
          await working.unroute("**/api/agent-sources");
          await working.evaluate(() =>
            window.dispatchEvent(new Event("loop-source-refresh")),
          );
          await expect
            .poll(() =>
              working.evaluate(
                () =>
                  window.__eventSockets.filter(
                    (socket) =>
                      new URL(socket.url).pathname !== "/ws" &&
                      socket.readyState === WebSocket.OPEN,
                  ).length,
              ),
            )
            .toBe(1);
          assert.equal(await localSockets(), 1);
          assert.equal(
            await working.evaluate(
              () =>
                window.__eventSockets.find(
                  (socket) => new URL(socket.url).pathname === "/ws",
                ).readyState,
            ),
            1,
          );
        }
        await done.goto(fixture.origin + "/?filter=done");
        await done.getByRole("button", { name: /Load more/i }).click();
        await expect(row(done, "Local history 0")).toHaveCount(1);
        const beforeCount = await done
          .locator(".inbox-results .inbox-card")
          .count();
        // A foreground append must preserve a notification queued behind a
        // slower head read. Start a fresh page to exclude periodic recovery.
        await working.reload();
        await expect(row(working, "Local task")).toHaveCount(1);
        await working.waitForTimeout(2500);
        let headHeld = false;
        let releaseHead;
        const headGate = new Promise((resolve) => {
          releaseHead = resolve;
        });
        await working.route("**/api/feed?*", async (route) => {
          const query = new URL(route.request().url()).searchParams;
          if (
            headHeld ||
            query.get("filter") !== "working" ||
            query.has("before")
          )
            return route.continue();
          const response = await route.fetch();
          headHeld = true;
          await headGate;
          await route.fulfill({ response });
        });
        try {
          await working.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("loop-workspace-change", {
                detail: { sources: [""] },
              }),
            ),
          );
          await expect.poll(() => headHeld).toBe(true);
          const updates = await working.evaluate(
            () => window.__workspaceUpdates,
          );
          complete(fixture, "Local");
          await expect
            .poll(() => working.evaluate(() => window.__workspaceUpdates))
            .toBeGreaterThan(updates);
          await working.waitForTimeout(400);
          const appended = working.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === "/api/feed" &&
              url.searchParams.get("filter") === "working" &&
              url.searchParams.has("before")
            );
          });
          await working.getByRole("button", { name: /Load more/i }).click();
          await appended;
          await expect(row(working, "Local task")).toHaveCount(0, {
            timeout: 3000,
          });
        } finally {
          releaseHead();
          await working.unrouteAll({ behavior: "wait" });
        }
        await expect(row(working, "Local task")).toHaveCount(0, {
          timeout: 5000,
        });
        await expect(row(done, "Local live final answer")).toHaveCount(1, {
          timeout: 5000,
        });
        await expect(row(done, "Local history 0")).toHaveCount(1);
        assert.ok(
          (await done.locator(".inbox-results .inbox-card").count()) >
            beforeCount,
        );
        if (remote) {
          await expect(row(working, "Remote task")).toHaveCount(1);
          complete(remote, "Remote");
          await expect(row(working, "Remote task")).toHaveCount(0, {
            timeout: 5000,
          });
          await expect(row(done, "Remote live final answer")).toHaveCount(1, {
            timeout: 5000,
          });
        }
        // Retain the final notification when it arrives during a slower read.
        let held = false,
          release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        await done.route("**/api/v1/cards/changes?*", async (route) => {
          if (
            held ||
            new URL(route.request().url()).searchParams.get("view") !== "done"
          )
            return route.continue();
          const response = await route.fetch();
          held = true;
          await gate;
          await route.fulfill({ response });
        });
        fixture.db
          .prepare(
            "UPDATE messages SET content='First edit' WHERE id='live-answer'",
          )
          .run();
        await expect.poll(() => held, { timeout: 5000 }).toBe(true);
        const updates = await done.evaluate(() => window.__workspaceUpdates);
        fixture.db
          .prepare(
            "UPDATE messages SET content='Final edit during refresh' WHERE id='live-answer'",
          )
          .run();
        await expect
          .poll(() => done.evaluate(() => window.__workspaceUpdates), {
            timeout: 5000,
          })
          .toBeGreaterThan(updates);
        await done.waitForTimeout(400); // App coalesces the notification before Feed sees it.
        release();
        await expect(row(done, "Final edit during refresh")).toHaveCount(1, {
          timeout: 5000,
        });
        // Reconcile revisions on reconnect even without new run events.
        await done.evaluate(() =>
          window.__eventSockets.forEach((socket) => socket.close()),
        );
        fixture.db
          .prepare(
            "UPDATE messages SET content='Changed while disconnected' WHERE id='live-answer'",
          )
          .run();
        await expect(row(done, "Changed while disconnected")).toHaveCount(1, {
          timeout: 5000,
        });
        await expect(row(done, "Local history 0")).toHaveCount(1);

        if (engine === "chromium" && mode === "server") {
          // Two Done tabs and sustained events must leave room under the
          // server's shared 600-request/minute owner limit for user actions.
          await working.goto(fixture.origin + "/?filter=done");
          await expect(row(working, "Changed while disconnected")).toHaveCount(
            1,
          );
          const before = await Promise.all(
            [working, done].map((page) =>
              page.evaluate(() => window.__workspaceUpdates),
            ),
          );
          const requests = [];
          const limited = [];
          const requested = (request) => {
            if (new URL(request.url()).pathname.startsWith("/api/"))
              requests.push(request.url());
          };
          const responded = (response) => {
            if (response.status() === 429) limited.push(response.url());
          };
          context.on("request", requested);
          context.on("response", responded);
          const stream = setInterval(() => {
            fixture.db
              .prepare(
                "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'live','delta','{}',?)",
              )
              .run(fixture.owner, Date.now());
          }, 100);
          try {
            await done.waitForTimeout(20_000);
          } finally {
            clearInterval(stream);
            context.off("request", requested);
            context.off("response", responded);
          }
          const after = await Promise.all(
            [working, done].map((page) =>
              page.evaluate(() => window.__workspaceUpdates),
            ),
          );
          assert.ok(
            after.every((count, i) => count - before[i] >= 8),
            "both tabs received sustained push updates",
          );
          assert.ok(
            requests.length <= 180,
            `two streaming tabs made ${requests.length} requests in 20 seconds`,
          );
          assert.deepEqual(
            limited,
            [],
            "stream refreshes must not exhaust the owner request limit",
          );
          console.log(
            `PASS two-tab streaming budget: ${requests.length} API requests in 20 seconds`,
          );
        }

        // HTTP-only clients remain healthy when a proxy blocks upgrades.
        await context.unroute(/\/api\/(?:agent-sources\/[^/]+\/)?events\?/);
        blockSockets = true;
        const cursor = fixture.db
          .prepare("SELECT max(id) cursor FROM events WHERE owner_id=?")
          .get(fixture.owner).cursor;
        await expect
          .poll(() =>
            done.evaluate(
              () =>
                window.__eventSockets
                  .filter((socket) =>
                    ["/ws", "/api/events/ws"].includes(
                      new URL(socket.url).pathname,
                    ),
                  )
                  .at(-1).__eventCursor,
            ),
          )
          .toBe(cursor);
        assert.ok(
          cursor >= 1000,
          "the socket already covered the historical events",
        );
        const firstPoll = done.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/events",
        );
        await done.evaluate(() =>
          window.__eventSockets.forEach((socket) => socket.close()),
        );
        assert.equal(
          Number(new URL((await firstPoll).url()).searchParams.get("after")),
          cursor,
          "fallback resumes at the socket watermark",
        );
        await expect(done.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        );
        await expect(done.locator(".connection-notice")).toHaveCount(0);
        await working.close();
        await done.close();
        const fallback = await context.newPage();
        fallback.on("pageerror", (e) => errors.push(e.message));
        await fallback.goto(fixture.origin + "/?filter=working");
        await expect(fallback.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        );
        await expect(fallback.locator(".connection-notice")).toHaveCount(0);
        fixture.db
          .transaction(() => {
            fixture.db
              .prepare(
                "UPDATE runs SET state='running',updated_at=? WHERE id='live'",
              )
              .run(Date.now());
            fixture.db
              .prepare(
                "INSERT INTO events(owner_id,run_id,type,payload,created_at) VALUES(?,'live','run_started','{}',?)",
              )
              .run(fixture.owner, Date.now());
          })
          .immediate();
        await expect(row(fallback, "Local task")).toHaveCount(1, {
          timeout: 5000,
        });
        await expect(fallback.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        );
        await expect(fallback.locator(".connection-notice")).toHaveCount(0);
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${engine}/${mode}: Working -> Done, retained history, concurrent refresh, reconnect, HTTP fallback health${remote ? ", linked source isolation" : ""}`,
        );
      } finally {
        process.env.PATH = priorPath;
        await context?.close();
        await fixture?.close();
        await remote?.close();
        if (dockerDir) rmSync(dockerDir, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
}
