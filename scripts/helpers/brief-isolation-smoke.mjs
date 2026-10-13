import assert from "node:assert/strict";
import { build } from "esbuild";
import { expect } from "@playwright/test";

export async function briefIsolationSmoke(page, fixture, normal) {
  const client = await page.context().newPage();
  client.setDefaultTimeout(8000);
  try {
    await client.route("**/brief-client-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<main id="brief-fixture"></main>',
      }),
    );
    await client.goto(fixture.base + "/brief-client-fixture");
    await client.addStyleTag({ path: "src/client/style.css" });
    await client.addStyleTag({ path: "src/client/projectBrief.css" });
    const result = await build({
      entryPoints: ["test/fixtures/brief-client.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"development"' },
    });
    await client.addScriptTag({ content: result.outputFiles[0].text });
    const make = (title, project = normal.project) => ({
      ...normal,
      project,
      version: 1,
      acknowledged_version: 1,
      headline: { text: title, cite: [] },
      goal: { text: title + " goal" },
    });
    const alpha = make("Owner A private context"),
      beta = make("Owner B workspace context"),
      gamma = make("Another project", "other-project");
    const render = (value) =>
      client.evaluate((value) => window.renderBrief(value), value);
    let current = alpha,
      holdRead = true,
      holdWrite = false,
      releaseRead,
      releaseWrite;
    const readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const destinations = [];
    await client.route("**/session", (route) =>
      route.fulfill({ json: { csrf: "fixture-csrf" } }),
    );
    await client.route("**/api/**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      destinations.push(path);
      if (path.endsWith("/brief/goal")) {
        const captured = current;
        if (holdWrite) await writeGate;
        return route.fulfill({
          json: { ...captured, goal: { text: request.postDataJSON().text } },
        });
      }
      if (path.endsWith("/brief")) {
        const captured = current;
        if (holdRead) {
          holdRead = false;
          await readGate;
        }
        return route.fulfill({ json: captured });
      }
      return route.fulfill({ json: { items: [] } });
    });
    const firstRead = client.waitForRequest((request) =>
      request.url().endsWith("/brief"),
    );
    await render({ owner: "owner-a", workspace: "", initial: alpha });
    await firstRead;
    await client.locator(".brief-goal").click();
    await client.getByLabel("Goal · you").fill("Private owner A draft");
    current = beta;
    await render({
      owner: "owner-b",
      workspace: "docker:fixture",
      initial: beta,
    });
    await expect(client.locator("dialog[open]")).toHaveCount(0);
    await expect(client.locator(".brief-headline h2")).toHaveText(
      beta.headline.text,
    );
    const oldRead = client.waitForResponse(
      (response) =>
        response.url().endsWith("/brief") &&
        !response.url().includes("agent-sources"),
    );
    releaseRead();
    await oldRead;
    await client.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(client.locator(".brief-headline h2")).toHaveText(
      beta.headline.text,
    );
    await client.locator(".brief-goal").click();
    await expect(client.getByLabel("Goal · you")).toHaveValue(beta.goal.text);
    holdWrite = true;
    await client.getByLabel("Goal · you").fill("Owner B pending edit");
    const write = client.waitForRequest((request) =>
      request.url().endsWith("/brief/goal"),
    );
    await client
      .getByRole("button", { name: "Save goal", exact: true })
      .click();
    await write;
    current = gamma;
    await render({
      owner: "owner-b",
      workspace: "docker:fixture",
      initial: gamma,
    });
    await expect(client.locator(".brief-headline h2")).toHaveText(
      gamma.headline.text,
    );
    const oldWrite = client.waitForResponse((response) =>
      response.url().endsWith("/brief/goal"),
    );
    releaseWrite();
    await oldWrite;
    await client.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(client.locator(".brief-goal")).toContainText(gamma.goal.text);
    const changes = await client.evaluate(() => window.briefChanges);
    assert(
      !changes.includes(alpha.headline.text),
      "A previous owner's response must never publish",
    );
    assert(
      destinations.some(
        (path) =>
          path.includes("/agent-sources/docker%3Afixture/") &&
          path.endsWith("/brief/goal"),
      ),
      "Mutations retain the originating workspace",
    );

    // Projects' initial fetch must also discard old identity data before mounting Brief.
    await client.unroute("**/api/**");
    let releaseParent,
      first = true;
    const parentGate = new Promise((resolve) => {
      releaseParent = resolve;
    });
    await client.route("**/api/**", async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/brief"))
        return route.fulfill({ json: { items: [] } });
      if (first) {
        first = false;
        await parentGate;
        return route.fulfill({ json: alpha });
      }
      return route.fulfill({ json: beta });
    });
    await client.evaluate(() =>
      sessionStorage.setItem("loop-project-tab", "brief"),
    );
    const parentRead = client.waitForRequest((request) =>
      request.url().endsWith("/brief"),
    );
    await render({
      owner: "owner-a",
      workspace: "",
      initial: alpha,
      parent: true,
    });
    await parentRead;
    await expect(
      client.getByText("Loading brief…", { exact: true }),
    ).toBeVisible();
    await render({
      owner: "owner-b",
      workspace: "docker:fixture",
      initial: beta,
      parent: true,
    });
    await expect(client.locator(".brief-headline h2")).toHaveText(
      beta.headline.text,
    );
    const parentResponse = client.waitForResponse(
      (response) =>
        response.url().endsWith("/brief") &&
        !response.url().includes("agent-sources"),
    );
    releaseParent();
    await parentResponse;
    await client.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(client.locator(".brief-headline h2")).toHaveText(
      beta.headline.text,
    );
    // A same-version refresh must observe the shared acknowledgement failure.
    // Its retry keeps the selected record tab and posts exactly one new request.
    await client.unroute("**/api/**");
    let releaseAck,
      ackRequests = 0;
    const ackGate = new Promise((resolve) => {
      releaseAck = resolve;
    });
    let ackPage = {
      ...make("Acknowledgement recovery"),
      version: 10,
      acknowledged_version: 9,
    };
    await client.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/brief/ack")) {
        ackRequests++;
        assert.equal(route.request().postDataJSON().version, 10);
        if (ackRequests === 1) {
          await ackGate;
          return route.fulfill({
            status: 503,
            json: { error: "Acknowledgement unavailable" },
          });
        }
        ackPage = { ...ackPage, acknowledged_version: 10 };
        return route.fulfill({ json: {} });
      }
      return route.fulfill({ json: ackPage });
    });
    await render({ owner: "ack-owner", workspace: "", initial: ackPage });
    await expect.poll(() => ackRequests).toBe(1);
    const decisions = client.getByRole("tab", { name: /^Decisions / });
    await decisions.click();
    const refresh = async () => {
      const response = client.waitForResponse((response) =>
        response.url().endsWith("/brief"),
      );
      await client.evaluate(() =>
        window.dispatchEvent(new Event("loop-refresh")),
      );
      await response;
      await client.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    };
    await refresh();
    assert.equal(ackRequests, 1);
    releaseAck();
    await expect(client.getByRole("alert")).toHaveText(
      /Acknowledgement unavailable/,
    );
    await expect(decisions).toHaveAttribute("aria-selected", "true");
    await client
      .getByRole("button", { name: "Retry brief", exact: true })
      .click();
    await expect.poll(() => ackRequests).toBe(2);
    await expect(client.getByRole("alert")).toHaveCount(0);
    await refresh();
    assert.equal(ackRequests, 2);
    await expect(decisions).toHaveAttribute("aria-selected", "true");

    // A failed acknowledgement for an older version cannot replace the newer
    // version's successful outcome or cause either version to be resent.
    await client.unroute("**/api/**");
    let releaseOlderAck;
    const olderAckGate = new Promise((resolve) => {
      releaseOlderAck = resolve;
    });
    const sentVersions = [];
    await client.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/brief/ack")) {
        const version = route.request().postDataJSON().version;
        sentVersions.push(version);
        if (version === 11) {
          await olderAckGate;
          return route.fulfill({
            status: 503,
            json: { error: "Older acknowledgement failed" },
          });
        }
        ackPage = { ...ackPage, acknowledged_version: version };
        return route.fulfill({ json: {} });
      }
      return route.fulfill({ json: ackPage });
    });
    ackPage = { ...ackPage, version: 11, acknowledged_version: 10 };
    await refresh();
    await expect.poll(() => sentVersions).toEqual([11]);
    ackPage = {
      ...ackPage,
      version: 12,
      headline: { text: "The newer version is acknowledged", cite: [] },
    };
    await refresh();
    await expect.poll(() => sentVersions).toEqual([11, 12]);
    const olderAckResponse = client.waitForResponse(
      (response) =>
        response.url().endsWith("/brief/ack") &&
        response.request().postDataJSON().version === 11,
    );
    releaseOlderAck();
    await olderAckResponse;
    const settle = () =>
      client.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    await settle();
    await expect(client.getByRole("alert")).toHaveCount(0);
    await refresh();
    assert.deepEqual(sentVersions, [11, 12]);
    await expect(client.locator(".brief-headline h2")).toHaveText(
      "The newer version is acknowledged",
    );

    // Returning to the same identity creates a fresh session. Its predecessor's
    // pending read must stay invalid even when owner/source/project match again.
    for (const dimension of ["owner", "workspace", "project"]) {
      await client.unroute("**/api/**");
      const original = {
        owner: "returning-owner",
        workspace: "",
        initial: make("Obsolete " + dimension, "returning-" + dimension),
      };
      const away = {
        owner: dimension === "owner" ? "other-owner" : original.owner,
        workspace: dimension === "workspace" ? "docker:fixture" : "",
        initial: make(
          "Away " + dimension,
          dimension === "project" ? "other-project" : original.initial.project,
        ),
      };
      const returned = make(
        "Fresh returned " + dimension,
        original.initial.project,
      );
      let currentPage = original.initial,
        firstRead = true,
        releaseOriginal;
      const originalGate = new Promise((resolve) => {
        releaseOriginal = resolve;
      });
      await client.route("**/api/**", async (route) => {
        if (
          firstRead &&
          new URL(route.request().url()).pathname.endsWith("/brief")
        ) {
          firstRead = false;
          await originalGate;
          return route.fulfill({
            headers: { "x-fixture-delayed": dimension },
            json: original.initial,
          });
        }
        return route.fulfill({ json: currentPage });
      });
      const initialRead = client.waitForRequest((request) =>
        request.url().endsWith("/brief"),
      );
      await render(original);
      await initialRead;
      currentPage = away.initial;
      await render(away);
      await expect(client.locator(".brief-headline h2")).toHaveText(
        away.initial.headline.text,
      );
      currentPage = returned;
      await render({ ...original, initial: returned });
      await expect(client.locator(".brief-headline h2")).toHaveText(
        returned.headline.text,
      );
      const staleResponse = client.waitForResponse(
        (response) => response.headers()["x-fixture-delayed"] === dimension,
      );
      releaseOriginal();
      await staleResponse;
      await settle();
      await expect(client.locator(".brief-headline h2")).toHaveText(
        returned.headline.text,
      );
      const published = await client.evaluate(() => window.briefChanges);
      assert(!published.includes(original.initial.headline.text));

      // The same round trip must not let an old save publish into the new
      // session, close its sheet, or replace the draft being edited there.
      await client.unroute("**/api/**");
      let releaseSave;
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      const obsoleteMutation = "Obsolete mutation " + dimension;
      await client.route("**/api/**", async (route) => {
        if (new URL(route.request().url()).pathname.endsWith("/brief/goal")) {
          await saveGate;
          return route.fulfill({
            json: {
              ...returned,
              headline: { text: obsoleteMutation, cite: [] },
              goal: { text: "Earlier saved goal" },
            },
          });
        }
        return route.fulfill({ json: currentPage });
      });
      await client.locator(".brief-goal").click();
      await client.getByLabel("Goal · you").fill("Earlier pending save");
      const saving = client.waitForRequest((request) =>
        request.url().endsWith("/brief/goal"),
      );
      await client
        .getByRole("button", { name: "Save goal", exact: true })
        .click();
      await saving;
      currentPage = away.initial;
      await render(away);
      await expect(client.locator(".brief-headline h2")).toHaveText(
        away.initial.headline.text,
      );
      currentPage = returned;
      await render({ ...original, initial: returned });
      await expect(client.locator(".brief-headline h2")).toHaveText(
        returned.headline.text,
      );
      await client.locator(".brief-goal").click();
      await client.getByLabel("Goal · you").fill("Keep the new draft");
      const saved = client.waitForResponse((response) =>
        response.url().endsWith("/brief/goal"),
      );
      releaseSave();
      await saved;
      await settle();
      await expect(client.getByLabel("Goal · you")).toHaveValue(
        "Keep the new draft",
      );
      const afterSave = await client.evaluate(() => window.briefChanges);
      assert(!afterSave.includes(obsoleteMutation));
      await client.getByRole("button", { name: "Close", exact: true }).click();
    }
  } finally {
    await client.close();
  }
}
