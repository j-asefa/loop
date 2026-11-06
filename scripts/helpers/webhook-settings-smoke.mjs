import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect } from "@playwright/test";

// Yield one task after the marked body is parsed, so the production async
// continuations finish before the fixture releases a later response.
async function observeResponseConsumption(page, header) {
  await page.evaluate((header) => {
    window.__webhookResponseConsumed = false;
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (response.headers.get(header) === "1") {
        window.fetch = original;
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            setTimeout(() => {
              window.__webhookResponseConsumed = true;
            }, 0);
          }
        };
      }
      return response;
    };
  }, header);
}

async function creationRecoveryRace(page, fixture, destination) {
  const refused = Promise.withResolvers();
  const release = Promise.withResolvers();
  const creations = [];
  let blockList = false;
  await observeResponseConsumption(page, "x-fixture-old-creation");
  await page.route("**/api/webhooks", async (route) => {
    if (route.request().method() === "GET")
      return blockList
        ? route.fulfill({
            status: 503,
            json: { error: "Fixture list unavailable" },
          })
        : route.continue();
    creations.push(route.request().postDataJSON());
    const index = creations.length;
    const response = await route.fetch();
    if (index === 1) {
      assert.equal(
        response.status(),
        400,
        "the production policy refuses link-local creation",
      );
      refused.resolve();
      await release.promise;
      await route.fulfill({
        response,
        headers: { ...response.headers(), "x-fixture-old-creation": "1" },
      });
    } else if (index === 3) {
      assert.equal(response.status(), 201);
      release.resolve();
      await page.waitForFunction(() => window.__webhookResponseConsumed);
      await route.abort("failed");
    } else {
      assert.equal(response.status(), 400);
      await route.fulfill({ response });
    }
  });
  const reopen = async (restoreList = false) => {
    await page
      .getByRole("dialog", { name: "Integration tokens", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    if (restoreList) blockList = false;
    await page
      .getByRole("button", { name: "Integration tokens", exact: true })
      .click();
  };
  await page
    .getByLabel("Receiver URL", { exact: true })
    .fill("https://169.254.0.1/receiver");
  await page.getByRole("button", { name: "Add receiver", exact: true }).click();
  await refused.promise;
  await reopen();
  await page
    .getByRole("button", { name: "Retry receiver creation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add receiver", exact: true }),
  ).toBeEnabled();
  blockList = true;
  await page.getByLabel("Receiver URL", { exact: true }).fill(destination);
  await page.getByRole("button", { name: "Add receiver", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry receiver creation", exact: true }),
  ).toBeEnabled();
  assert.equal(creations.length, 3);
  assert.deepEqual(creations[1], creations[0]);
  assert.notEqual(creations[2].request_id, creations[0].request_id);
  await reopen(true);
  const row = page
    .getByRole("group", { name: "Webhook receivers", exact: true })
    .locator(":scope > div")
    .filter({ has: page.getByText(destination, { exact: true }) });
  await expect(
    row.getByText("Pending activation", { exact: true }),
  ).toBeVisible();
  const secretBox = page
    .locator(".settings-command")
    .filter({ hasText: "Webhook signing secret" });
  await expect(secretBox.locator("pre")).toHaveText(creations[2].secret);
  assert.equal(creations.length, 3, "reopening recovers without another POST");
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM webhook_subscriptions WHERE id=?")
      .get(creations[2].request_id).n,
    1,
  );
  assert.equal(
    fixture.db
      .prepare(
        "SELECT count(*) n FROM webhook_deliveries WHERE subscription_id=? AND purpose='activation'",
      )
      .get(creations[2].request_id).n,
    1,
  );
  await page
    .getByRole("button", { name: "Hide signing secret", exact: true })
    .click();
  await row
    .getByRole("button", { name: "Revoke receiver", exact: true })
    .click();
  await expect(row.getByText("revoked", { exact: true })).toBeVisible();
  await page.unroute("**/api/webhooks");
}

/** Real loopback receiver for the companion. No public receiver or tunnel is used. */
export async function webhookSettingsReceiver() {
  let status = 503;
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(status).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/receiver";
  return {
    url,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
    async exercise(page, fixture, width) {
      status = 503;
      const destination = url + "?width=" + width;
      await expect(
        page.getByText(/This companion accepts local HTTP/),
      ).toBeVisible();
      await creationRecoveryRace(
        page,
        fixture,
        destination + "&creation-race=1",
      );
      // A committed creation whose response is lost is recovered by its UUID.
      let creation,
        posts = 0;
      await page.route("**/api/webhooks", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        creation = route.request().postDataJSON();
        await route.fetch();
        await route.abort("failed");
      });
      await page.getByLabel("Receiver URL", { exact: true }).fill(destination);
      await page
        .getByRole("button", { name: "Add receiver", exact: true })
        .click();
      const row = page
        .getByRole("group", { name: "Webhook receivers", exact: true })
        .locator(":scope > div")
        .filter({ has: page.getByText(destination, { exact: true }) });
      await expect(
        row.getByText("Pending activation", { exact: true }),
      ).toBeVisible();
      await expect(row).toContainText("Ping attempts: 1");
      const secretBox = page
        .locator(".settings-command")
        .filter({ hasText: "Webhook signing secret" });
      const secret = await secretBox.locator("pre").textContent();
      assert.match(secret, /^loop_hook_[\w-]{43}$/);
      assert.equal(secret, creation.secret);
      assert.equal(posts, 1);
      assert.equal(
        fixture.db
          .prepare("SELECT count(*) n FROM webhook_subscriptions WHERE id=?")
          .get(creation.request_id).n,
        1,
      );
      assert.equal(
        fixture.db
          .prepare(
            "SELECT count(*) n FROM webhook_deliveries WHERE subscription_id=? AND purpose='activation'",
          )
          .get(creation.request_id).n,
        1,
      );
      await expect(
        page.getByRole("alert").filter({
          hasText: "Retry uses the same receiver and activation ping.",
        }),
      ).toHaveCount(0);
      await page.unroute("**/api/webhooks");
      await page
        .getByRole("button", { name: "Copy signing secret", exact: true })
        .click();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        secret,
      );
      assert(
        !(
          await page.evaluate(() =>
            JSON.stringify({
              local: { ...localStorage },
              session: { ...sessionStorage },
              url: location.href,
            }),
          )
        ).includes(secret),
      );
      await page
        .getByRole("button", { name: "Hide signing secret", exact: true })
        .click();
      await expect(secretBox).toHaveCount(0);
      const subscription = fixture.db
        .prepare("SELECT id FROM webhook_subscriptions WHERE url=?")
        .get(destination);
      const ping = fixture.db
        .prepare("SELECT id FROM webhook_deliveries WHERE subscription_id=?")
        .get(subscription.id).id;
      status = 204;
      await row
        .getByRole("button", { name: "Retry deliveries", exact: true })
        .click();
      await expect(
        row.getByRole("button", { name: "Retry deliveries", exact: true }),
      ).toBeEnabled();
      await fixture.webhookFixture("deliver");
      await page
        .getByRole("button", { name: "Refresh receivers", exact: true })
        .click();
      await expect(row.getByText("active", { exact: true })).toBeVisible();
      assert.equal(received.filter((message) => message.id === ping).length, 2);
      // Delay disable across closing Settings. After the reopened instance
      // recovers it and records enable, settle the old response first, then
      // lose enable's response. The old instance must not clear enable's ID.
      const toggle = row.getByRole("checkbox", { name: /^Run stopped/ });
      const updates = [];
      const updatePath = "**/api/webhooks/" + subscription.id;
      const committed = Promise.withResolvers();
      const release = Promise.withResolvers();
      await observeResponseConsumption(page, "x-fixture-old-update");
      await page.route(updatePath, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        updates.push(route.request().postDataJSON());
        const index = updates.length;
        const response = await route.fetch();
        if (index === 1) {
          committed.resolve();
          await release.promise;
          await route.fulfill({
            response,
            headers: { ...response.headers(), "x-fixture-old-update": "1" },
            ...(width === 1280
              ? { status: 400, json: { error: "Delayed fixture refusal" } }
              : {}),
          });
        } else if (index === 3) {
          release.resolve();
          await page.waitForFunction(() => window.__webhookResponseConsumed);
          await route.abort("failed");
        } else await route.fulfill({ response });
      });
      const uncertain = page.getByRole("alert").filter({
        hasText: "Retry this action to recover the same request.",
      });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await committed.promise;
      await page
        .getByRole("dialog", { name: "Integration tokens", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Integration tokens", exact: true })
        .click();
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(uncertain).toBeVisible();
      assert.equal(updates.length, 3);
      assert.deepEqual(updates[1], updates[0]);
      assert.deepEqual(updates[0].kinds, []);
      assert.deepEqual(updates[2].kinds, ["run.stopped"]);
      assert.notEqual(updates[2].request_id, updates[0].request_id);
      await page
        .getByRole("dialog", { name: "Integration tokens", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Integration tokens", exact: true })
        .click();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(toggle).toBeEnabled();
      assert.equal(updates.length, 5);
      assert.deepEqual(updates[3], updates[2]);
      assert.deepEqual(updates[4].kinds, []);
      assert.notEqual(updates[4].request_id, updates[2].request_id);
      assert.equal(
        fixture.db
          .prepare("SELECT kinds FROM webhook_subscriptions WHERE id=?")
          .get(subscription.id).kinds,
        "[]",
      );
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeEnabled();
      assert.equal(updates.length, 6);
      assert.deepEqual(updates[5].kinds, ["run.stopped"]);
      assert.notEqual(updates[5].request_id, updates[4].request_id);
      await expect(uncertain).toHaveCount(0);
      await page.unroute(updatePath);
      await row
        .getByRole("button", { name: "Test receiver", exact: true })
        .click();
      await expect(
        row.getByRole("list", { name: "Recent webhook deliveries" }),
      ).toContainText("Test ping");
      await expect(
        row.getByRole("button", { name: "Test receiver", exact: true }),
      ).toBeEnabled();
      const records = await fixture.integrationRecords();
      status = 503;
      for (let i = 0; i < 6; i++) {
        fixture.db
          .prepare(
            "UPDATE webhook_deliveries SET available_at=0 WHERE subscription_id=? AND delivered_at IS NULL",
          )
          .run(subscription.id);
        await fixture.webhookFixture("deliver");
      }
      await page
        .getByRole("button", { name: "Refresh receivers", exact: true })
        .click();
      await expect(row.getByText("failed", { exact: true })).toBeVisible();
      await expect(row).toContainText("Failed delivery: 6 attempts");
      await expect(row).toContainText("Receiver returned HTTP 503");
      await fixture.webhookFixture("transition", {
        owner: fixture.owner,
        agent: records.agent,
        conversation: records.conversation,
        from: "queued",
        to: "cancelled",
      });
      await row
        .getByRole("button", { name: "Recent deliveries", exact: true })
        .click();
      await expect(
        row.getByRole("list", { name: "Recent webhook deliveries" }),
      ).toContainText("Paused until you retry deliveries");
      status = 204;
      await row
        .getByRole("button", { name: "Retry deliveries", exact: true })
        .click();
      await expect(row.getByText("active", { exact: true })).toBeVisible();
      await fixture.webhookFixture("deliver");
      await row
        .getByRole("button", { name: "Recent deliveries", exact: true })
        .click();
      await expect(
        row.getByRole("list", { name: "Recent webhook deliveries" }),
      ).toContainText("Last outcome: accepted");
      await row
        .getByRole("button", { name: "Revoke receiver", exact: true })
        .click();
      await expect(row.getByText("revoked", { exact: true })).toBeVisible();
      await expect(
        row.getByRole("button", { name: "Retry deliveries", exact: true }),
      ).toHaveCount(0);
      console.log(`Webhook Settings journey passed: companion, ${width}px`);
    },
  };
}
