import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { openSettings } from "./browser-ui.mjs";

// Exercise the production server and Connections caller with a fake external
// broker. Expiry is display metadata, never proof that login completed.
export async function subscriptionContractsBrowser({ browser }) {
  const { designFixture } = await import("./design-fixture.mjs");
  const token = "contract-broker-fixture-token-at-least-32-characters";
  let state = "waiting",
    expiry,
    fixture,
    context,
    logins = 0;
  const broker = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (req.url === "/health") {
      res.end(JSON.stringify({ ok: true, kind: "broker" }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { action } = JSON.parse(raw);
    if (action === "login") {
      state = "waiting";
      logins++;
    }
    res.end(
      JSON.stringify({
        state,
        ...(expiry === undefined ? {} : { expiresAt: expiry }),
        ...(state === "waiting"
          ? {
              login: {
                url: "https://claude.com/cai/oauth/authorize?fixture=expiry",
                acceptsCode: true,
              },
            }
          : {}),
        ...(state === "failed"
          ? { error: "Fixture login expired. Try sign-in again." }
          : {}),
      }),
    );
  });
  await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const brokerUrl = `http://127.0.0.1:${broker.address().port}`;
  const previousOrigins = process.env.LOOP_ALLOWED_RUNTIME_ORIGINS;
  process.env.LOOP_ALLOWED_RUNTIME_ORIGINS = brokerUrl;
  try {
    fixture = await designFixture();
    const host = await fixture.api("/runtime-hosts", {
      name: "Expiry fixture",
      url: brokerUrl,
      token,
      kind: "broker",
    });
    const connection = await fixture.api("/subscriptions", {
      provider: "claude",
      label: "Legacy expiry",
      runtimeHostId: host.id,
    });
    const path = `/subscriptions/${connection.id}`;
    const waiting = await fixture.api(path + "/login", {});
    assert.equal(waiting.state, "waiting");
    assert(!("expiresAt" in waiting));
    for (const value of ["starting", "waiting", "failed", "cancelled"]) {
      state = value;
      const result = await fixture.api(path + "/status", {});
      assert.equal(result.state, value);
      assert(!("expiresAt" in result));
    }
    assert.equal(
      fixture.db
        .prepare("SELECT status FROM connections WHERE id=?")
        .get(connection.id).status,
      "needs_sign_in",
    );
    expiry = "invalid";
    const malformed = await fetch(fixture.base + "/api" + path + "/status", {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(malformed.status, 500);
    assert.deepEqual(await malformed.json(), {
      error: "The workspace response is unavailable. Please try again.",
    });

    expiry = Date.now() + 60000;
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = [],
      omitted = new Set();
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route(
      new RegExp(`/api/subscriptions/${connection.id}/(login|status)$`),
      async (route) => {
        const response = await route.fetch(),
          body = await response.json();
        assert(response.ok());
        assert.equal(typeof body.expiresAt, "number");
        omitted.add(body.state);
        delete body.expiresAt;
        await route.fulfill({ response, json: body });
      },
    );
    await page.goto(fixture.base);
    await openSettings(page);
    await page.getByRole("button", { name: /Provider connections/ }).click();
    await page
      .getByRole("region", { name: "Claude: Legacy expiry", exact: true })
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    const signing = page.getByRole("dialog", {
      name: "Sign in to Claude",
      exact: true,
    });
    const link = signing.getByRole("link", { name: "Open Claude sign-in" });
    await expect(link).toHaveAttribute(
      "href",
      "https://claude.com/cai/oauth/authorize?fixture=expiry",
    );
    assert(omitted.has("waiting"));
    await expect(signing.getByText(/Expires at/)).toHaveCount(0);
    await expect(signing.getByRole("alert")).toHaveCount(0);
    state = "failed";
    await expect(signing.getByRole("alert")).toHaveText(
      "Fixture login expired. Try sign-in again.",
    );
    const retry = signing.getByRole("button", {
      name: "Try sign-in again",
      exact: true,
    });
    await expect(retry).toBeEnabled();
    assert(omitted.has("waiting") && omitted.has("failed"));
    await mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: `test-results/subscription-contracts-${process.env.LOOP_BROWSER || "chromium"}-expiry.png`,
      fullPage: true,
    });
    const beforeRetry = logins;
    await retry.click();
    await expect(link).toBeVisible();
    assert.equal(logins, beforeRetry + 1);
    await expect(signing.getByRole("alert")).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log("Subscription expiry omission preserves sign-in and retry:", [
      ...omitted,
    ]);
  } finally {
    await context?.unrouteAll({ behavior: "wait" });
    await context?.close();
    await fixture?.close();
    await new Promise((resolve) => broker.close(resolve));
    if (previousOrigins === undefined)
      delete process.env.LOOP_ALLOWED_RUNTIME_ORIGINS;
    else process.env.LOOP_ALLOWED_RUNTIME_ORIGINS = previousOrigins;
  }
}
