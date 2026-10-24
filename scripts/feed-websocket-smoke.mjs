import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit, expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";

// Foreign commits wake the 250ms change drain, followed by up to two seconds
// of source coalescing and 250ms of App coalescing.
const revisionTimeout = 8000;

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
                if (frame.v === 3) this.__eventCursor = frame.cursor;
                if (frame.type === "reset") this.__resetFrame = frame;
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
          // The last metadata signal must survive a source-specific cooldown.
          let limitedMetadata = false;
          await working.route("**/api/agent-sources/*/bootstrap", route => {
            if (limitedMetadata) return route.continue();
            limitedMetadata = true;
            return route.fulfill({status:429,headers:{"Retry-After":"2"},json:{error:"Fixture metadata cooldown"}});
          });
          remote.db.prepare("UPDATE agents SET name='Remote recovered' WHERE id='agent'").run();
          await expect.poll(() => limitedMetadata).toBe(true);
          await expect(working.getByRole("region", {name:"Your agents"})).toContainText("@Remote recovered", {timeout:revisionTimeout});
          await working.unroute("**/api/agent-sources/*/bootstrap");
          // A successful run read cannot clear a failed metadata projection.
          // Discovery must keep retrying the source until bootstrap recovers.
          let failedMetadataReads = 0;
          await working.route("**/api/agent-sources/*/bootstrap", route => {
            failedMetadataReads++;
            return route.fulfill({status:403,json:{error:"Fixture metadata unavailable"}});
          });
          remote.db.prepare("UPDATE agents SET name='Remote metadata recovered' WHERE id='agent'").run();
          const metadataWarning = working.getByRole("status").filter({hasText:"An environment is temporarily unavailable. Its last loaded agents are still shown."});
          await expect(metadataWarning).toBeVisible({timeout:revisionTimeout});
          const failedBeforeRuns = failedMetadataReads;
          const linkedSource = await working.evaluate(() => decodeURIComponent(new URL(window.__eventSockets.find(socket =>
            new URL(socket.url).pathname.includes("/agent-sources/")).url).pathname.split("/agent-sources/")[1].split("/")[0]));
          await working.evaluate(source => window.dispatchEvent(new CustomEvent("loop-workspace-change",{
            detail:{sources:[source],changes:[{source,events:[{type:"invalidate",scope:{kind:"collection",id:"runs"}}]}]},
          })),linkedSource);
          await expect.poll(() => failedMetadataReads,{timeout:revisionTimeout}).toBeGreaterThan(failedBeforeRuns);
          await expect(metadataWarning).toBeVisible();
          await working.unroute("**/api/agent-sources/*/bootstrap");
          await expect(working.getByRole("region",{name:"Your agents"})).toContainText("@Remote metadata recovered",{timeout:35000});
          await expect(metadataWarning).toHaveCount(0);
          console.log(`PASS ${engine} run refresh preserves metadata failure and discovery recovers the source`);
          remote.db.prepare("UPDATE agents SET name='Remote' WHERE id='agent'").run();
          fixture.db.prepare("INSERT INTO native_decisions(id,run_id,conversation_id,generation,native_id,request,created_at) VALUES('late-decision','live','thread','fixture','adapter',?,?)")
            .run(JSON.stringify({id:"adapter",kind:"approval",title:"Late decision snapshot",detail:"Fixture only",choices:["allow","deny"]}),Date.now());
          const decision = working.getByRole("heading", {name:"Late decision snapshot"});
          await expect(decision).toHaveCount(1);
          let capturedDecision = false, releaseDecision, deliveredDecision;
          const decisionGate = new Promise(resolve => { releaseDecision = resolve; });
          const decisionDelivered = new Promise(resolve => { deliveredDecision = resolve; });
          await working.route("**/api/native/decisions", async route => {
            if (capturedDecision) return route.continue();
            const response = await route.fetch();
            capturedDecision = true;
            await decisionGate;
            await route.fulfill({response});
            deliveredDecision();
          });
          try {
            await working.evaluate(() => window.dispatchEvent(new CustomEvent("loop-workspace-change", {detail:{sources:[""],changes:[{source:"",events:[{type:"invalidate",scope:{kind:"collection",id:"decisions"}}]}]}})));
            await expect.poll(() => capturedDecision).toBe(true);
            fixture.db.prepare("UPDATE native_decisions SET state='resolved' WHERE id='late-decision'").run();
            await expect(decision).toHaveCount(0, {timeout:revisionTimeout});
            releaseDecision();await decisionDelivered;
            await working.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await expect(decision).toHaveCount(0);
          } finally {
            releaseDecision();
            await working.unroute("**/api/native/decisions");
            fixture.db.prepare("DELETE FROM native_decisions WHERE id='late-decision'").run();
          }
          console.log(`PASS ${engine} native decision rejects an older pending snapshot after resolution`);
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
                detail: {
                  sources: [""],
                  changes: [{ source: "", events: [{ type: "invalidate", scope: { kind: "collection", id: "feed" } }] }],
                },
              }),
            ),
          );
          await expect.poll(() => headHeld).toBe(true);
          const updates = await working.evaluate(
            () => window.__workspaceUpdates,
          );
          complete(fixture, "Local");
          await expect
            .poll(() => working.evaluate(() => window.__workspaceUpdates), { timeout: revisionTimeout })
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
            timeout: revisionTimeout,
          });
          await expect(row(done, "Remote live final answer")).toHaveCount(1, {
            timeout: revisionTimeout,
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
        await expect.poll(() => held, { timeout: revisionTimeout }).toBe(true);
        const updates = await done.evaluate(() => window.__workspaceUpdates);
        fixture.db
          .prepare(
            "UPDATE messages SET content='Final edit during refresh' WHERE id='live-answer'",
          )
          .run();
        await expect
          .poll(() => done.evaluate(() => window.__workspaceUpdates), {
            timeout: revisionTimeout,
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

        if (mode === "server") {
          // A complete source applies real message identities in place. Leave
          // the stream quiet beyond both former five-second thread timers.
          fixture.db.prepare("UPDATE runs SET state='running' WHERE id='live'").run();
          const thread = await context.newPage();
          await thread.goto(fixture.origin + "/?conversation=thread");
          const answer = thread.locator('[data-message-id="live-answer"]');
          await expect(answer).toContainText("Changed while disconnected");
          await thread.waitForTimeout(2500);
          const transcriptReads = [], idleReads = [];
          let idle = false;
          const record = request => {
            const path = new URL(request.url()).pathname;
            if (request.method() === "GET" && path === "/api/conversations/thread") transcriptReads.push(path);
            if (idle && path.startsWith("/api/")) idleReads.push(path);
          };
          thread.on("request", record);
          for (let n = 1; n <= 6; n++) {
            const text = "Live projection " + "token ".repeat(n);
            fixture.db.prepare("UPDATE messages SET content=? WHERE id='live-answer'").run(text);
            await expect(answer).toContainText(text.trim());
          }
          await thread.waitForTimeout(2500);
          idle = true;
          await thread.waitForTimeout(6500);
          assert.equal(transcriptReads.length, 0, "streaming transcript must not refetch its snapshot");
          const feedMode = await thread.evaluate(() => window.__eventSockets.find(socket => socket.__resetFrame?.v === 3)?.__resetFrame.capabilities.feed);
          assert.ok(["snapshot","delta"].includes(feedMode), "the source must declare its Feed delivery mode");
          // A snapshot Feed retains its 30s poll (two Feed reads and a Cards
          // change read). Once Feed advertises deltas, the strict total budget
          // applies automatically; covered transcript/Results paths stay quiet.
          const coveredReads = feedMode === "snapshot"
            ? idleReads.filter(path => !["/api/feed","/api/v1/cards/changes"].includes(path)) : idleReads;
          assert.ok(coveredReads.length <= 2, `covered surfaces made ${coveredReads.length} quiet requests: ${coveredReads}`);
          assert.ok(idleReads.length <= (feedMode === "snapshot" ? 5 : 2), `quiet stream made ${idleReads.length} API requests between frames: ${idleReads}`);
          console.log(`PASS ${engine} transcript deltas: zero snapshot reads; ${idleReads.length} requests during 6.5s without frames`);
          thread.off("request", record);
          // Recover an unloaded row without exposing a detached history page.
          const recovery = thread.waitForResponse(response => {
            const url = new URL(response.url());
            return url.pathname === "/api/conversations/thread" && url.searchParams.get("message") === "answer-0";
          });
          fixture.db.prepare("UPDATE messages SET content=content||' recovered older chunk' WHERE id='answer-0'").run();
          await (await recovery).finished();
          fixture.db.prepare("UPDATE messages SET content='Updated unloaded history' WHERE id='answer-0'").run();
          await expect(row(done, "Updated unloaded history")).toHaveCount(1, {timeout:revisionTimeout});
          await expect(thread.locator('[data-message-id="answer-0"]')).toHaveCount(0);
          await thread.getByRole("button", {name:"Load earlier messages",exact:true}).click();
          await expect(thread.locator('[data-message-id="answer-0"]')).toContainText("Updated unloaded history");
          const loadedIds = await thread.locator('[data-message-id]').evaluateAll(rows => rows.map(row => row.dataset.messageId).sort());
          // A reset replaces the loaded page set. Its new cursor must let the
          // reader request the discarded history again, including the middle.
          fixture.db.prepare("UPDATE messages SET content=content||' reset probe' WHERE id='live-answer'").run();
          await expect(answer).toContainText("reset probe");
          const clock = (await (await fixture.request("/api/conversations/thread", {headers:fixture.browser})).json()).projection;
          const resetRead = thread.waitForResponse(response => new URL(response.url()).pathname === "/api/conversations/thread");
          await thread.evaluate(clock => {
            const socket = window.__eventSockets.find(socket => socket.__resetFrame?.v === 3);
            if (!socket?.onmessage) throw new Error("Missing reset-capable socket");
            socket.onmessage(new MessageEvent("message", {data:JSON.stringify({...socket.__resetFrame,...clock,type:"reset"})}));
          }, clock);
          await (await resetRead).finished();
          await expect(thread.locator('[data-message-id="answer-0"]')).toHaveCount(0);
          await thread.getByRole("button", {name:"Load earlier messages",exact:true}).click();
          await expect.poll(() => thread.locator('[data-message-id]').evaluateAll(rows => rows.map(row => row.dataset.messageId).sort())).toEqual(loadedIds);
          console.log(`PASS ${engine} unloaded deltas stay outside displayed pages and reset pagination restores all history`);
          // Fault-inject a missing frame, then explicitly refresh. An absent
          // row in the page must disappear instead of merging back from cache.
          fixture.db.prepare("INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES('snapshot-delete',?,'thread','assistant','Temporary display row',?)").run(fixture.owner,Date.now());
          await expect(thread.locator('[data-message-id="snapshot-delete"]')).toHaveCount(1);
          await thread.evaluate(() => window.__eventSockets.forEach(socket => { socket.__forward = socket.onmessage; socket.onmessage = null; }));
          fixture.db.prepare("DELETE FROM messages WHERE id='snapshot-delete'").run();
          await thread.evaluate(() => window.dispatchEvent(new Event("loop-refresh")));
          await expect(thread.locator('[data-message-id="snapshot-delete"]')).toHaveCount(0);
          await thread.evaluate(() => window.__eventSockets.forEach(socket => { socket.onmessage = socket.__forward; }));
          console.log(`PASS ${engine} transcript gap recovery and explicit-refresh deletion reconciliation`);
          await thread.close();
          fixture.db.transaction(() => {
            fixture.db.prepare("UPDATE runs SET state='completed' WHERE id='live'").run();
            fixture.db.prepare("UPDATE messages SET content='Changed while disconnected' WHERE id='live-answer'").run();
          }).immediate();
          await expect(row(done, "Changed while disconnected")).toHaveCount(1, {timeout: revisionTimeout});
        }

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

        // Give HTTP fallback its own database/request budget after the many
        // navigation and streaming probes above; keep the real 600/min limit.
        await working.close();
        await done.close();
        await fixture.close();
        fixture = undefined;
        if (dockerDir) process.env.PATH = dockerDir + ":" + priorPath;
        fixture = await cardsFixture(mode, true);
        process.env.PATH = priorPath;
        seed(fixture, "Local", 2, 0);
        complete(fixture, "Local");
        if (fixture.browser.cookie) {
          const [name,value] = fixture.browser.cookie.split("=");
          await context.addCookies([{name,value,url:fixture.origin,httpOnly:true,sameSite:"Lax"}]);
        }
        await context.unroute(/\/api\/(?:agent-sources\/[^/]+\/)?events\?/);
        const replay = await context.newPage();
        replay.on("pageerror", e => { if (!isWebKitNavigationFetchError(engine,e,fixture.origin)) errors.push(e.message); });
        await replay.goto(fixture.origin + "/?filter=working");
        await expect(replay.locator(".workspace-connection")).toHaveText("Connected to workspace");
        blockSockets = true;
        const cursor = fixture.db
          .prepare("SELECT max(id) cursor FROM events WHERE owner_id=?")
          .get(fixture.owner).cursor;
        await expect
          .poll(() =>
            replay.evaluate(
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
        const firstPoll = replay.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/events",
        );
        await replay.evaluate(() =>
          window.__eventSockets.forEach((socket) => socket.close()),
        );
        assert.equal(
          Number(new URL((await firstPoll).url()).searchParams.get("after")),
          cursor,
          "fallback resumes at the socket watermark",
        );
        await expect(replay.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        );
        await expect(replay.locator(".connection-notice")).toHaveCount(0);
        await replay.close();
        const fallback = await context.newPage();
        const fallbackRequests = [];
        fallback.on("response", response => {
          const url = new URL(response.url());
          if (url.pathname.startsWith("/api/")) fallbackRequests.push({path:url.pathname,status:response.status()});
        });
        fallback.on("requestfailed", request => fallbackRequests.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
        fallback.on("pageerror", (e) => errors.push(e.message));
        await fallback.goto(fixture.origin + "/?filter=working");
        await expect(fallback.locator(".workspace-connection")).toHaveText(
          "Connected to workspace",
        ).catch(error => {
          console.error("HTTP fallback diagnostic", JSON.stringify({engine,mode,requests:fallbackRequests,limits:fixture.db.prepare("SELECT window,count FROM request_limits WHERE owner_id=?").get(fixture.owner)}));
          throw error;
        });
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
        }).catch(error => {
          console.error("HTTP fallback transition diagnostic", JSON.stringify({engine,mode,requests:fallbackRequests,limits:fixture.db.prepare("SELECT window,count FROM request_limits WHERE owner_id=?").get(fixture.owner)}));
          throw error;
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
