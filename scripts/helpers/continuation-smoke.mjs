import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

async function setupContinuation(page, fixture) {
  const connection = await fixture.api("/connections", {
    provider: "openai",
    label: "Continuation fixture",
    secret: "fixture-only",
  });
  const makeAgent = (name) =>
    fixture.api("/agents", {
      name,
      connectionId: connection.id,
      model: connection.models[0].id,
    });
  const sourceAgent = await makeAgent("continuation-origin");
  const target = await makeAgent("continuation-target");
  const source = randomUUID();
  const time = Date.now() - 60000;
  fixture.db
    .prepare(
      "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,'Browser smoke',?)",
    )
    .run(source, fixture.owner, sourceAgent.id, time);
  const insert = fixture.db.prepare(
    "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?,?)",
  );
  const dialog = (tab = page) =>
    tab.getByRole("dialog", {
      name: "Continue with another agent",
      exact: true,
    });
  const open = async (tab = page) => {
    await tab.getByLabel("Conversation options", { exact: true }).click();
    await tab
      .getByRole("menuitem", {
        name: "Continue with another agent",
        exact: true,
      })
      .click();
  };
  await page.setViewportSize({ width: 390, height: 844 });
  return { source, sourceAgent, target, insert, time, dialog, open };
}

export async function continuationSmoke(page, fixture) {
  const { source, target, insert, time, dialog, open } =
    await setupContinuation(page, fixture);
  insert.run(
    randomUUID(),
    fixture.owner,
    source,
    "assistant",
    "The browser smoke needs another look.",
    time,
  );
  insert.run(
    randomUUID(),
    fixture.owner,
    source,
    "user",
    "What can we do about the browser smoke?",
    time + 1,
  );
  insert.run(
    randomUUID(),
    fixture.owner,
    source,
    "assistant",
    "This message should stay out of the continuation.",
    time + 2,
  );
  await page.goto(`${fixture.base}/?conversation=${source}`);
  await open();
  await dialog()
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption(target.id);
  await dialog().getByRole("checkbox").nth(0).check();
  await dialog().getByRole("checkbox").nth(1).check();
  await dialog().getByRole("checkbox").nth(2).uncheck();
  const prompt = "Please answer the browser smoke question.";
  await dialog()
    .getByRole("textbox", { name: "Message to new agent", exact: true })
    .fill(prompt);
  const requests = [];
  let receipt;
  let loseResponse = true;
  const refusals = [429, 403];
  await page.route(
    `**/api/conversations/${source}/continue/start`,
    async (route) => {
      requests.push(route.request().postDataJSON());
      if (loseResponse) {
        loseResponse = false;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        receipt = await response.json();
        await route.abort("failed"); // The server committed; the phone lost its acknowledgement.
      } else if (refusals.length) {
        const status = refusals.shift();
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ error: `Fixture refusal ${status}` }),
        });
      } else await route.continue();
    },
  );
  await dialog()
    .getByRole("button", { name: "Start continuation", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Couldn’t reach Loop55",
  );
  await expect(
    dialog().getByRole("textbox", {
      name: "Message to new agent",
      exact: true,
    }),
  ).toBeDisabled();
  assert.ok(
    receipt.runId,
    "Starting the continuation must enqueue the first turn",
  );
  await page.reload();
  await open();
  await expect(
    dialog().getByRole("textbox", {
      name: "Message to new agent",
      exact: true,
    }),
  ).toHaveValue(prompt);
  await expect(
    dialog().getByRole("combobox", { name: "Continue with", exact: true }),
  ).toHaveValue(target.id);
  await expect(dialog().getByRole("checkbox").nth(1)).toBeChecked();
  await expect(dialog().getByRole("checkbox").nth(2)).not.toBeChecked();
  await expect(
    dialog().getByText(/your message and the 2 selected messages/),
  ).toBeVisible();
  for (const status of [429, 403]) {
    await dialog()
      .getByRole("button", { name: "Retry continuation", exact: true })
      .click();
    await expect(dialog().getByRole("alert")).toContainText(
      `Fixture refusal ${status}`,
    );
    await expect(
      dialog().getByRole("textbox", {
        name: "Message to new agent",
        exact: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await open();
  }
  // A refreshed transcript can hide every selected row. Recovery still uses
  // the saved selection and remains available without new transcript choices.
  fixture.db
    .prepare("UPDATE messages SET metadata=? WHERE conversation_id=?")
    .run(JSON.stringify({ progress: true }), source);
  await page.reload();
  await open();
  await expect(dialog().getByRole("checkbox")).toHaveCount(0);
  await expect(
    dialog().getByText(/your message and the 2 selected messages/),
  ).toBeVisible();
  await expect(
    dialog().getByRole("button", { name: "Retry continuation", exact: true }),
  ).toBeEnabled();
  await dialog()
    .getByRole("button", { name: "Retry continuation", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  assert.equal(requests.length, 4);
  for (const request of requests.slice(1))
    assert.deepEqual(
      request,
      requests[0],
      "Refused retries must preserve the original send and identity",
    );
  await expect(
    page.locator(".conversation-sheet .thread-head").getByRole("button", {
      name: `Open @${target.name} profile`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Reply to agent" }),
  ).toHaveAttribute(
    "placeholder",
    `Reply to ${target.name.charAt(0).toUpperCase() + target.name.slice(1)}…`,
  );
  assert.deepEqual(
    fixture.db
      .prepare(
        "SELECT id,agent_id,state,input FROM runs WHERE conversation_id=?",
      )
      .all(receipt.id),
    [
      {
        id: receipt.runId,
        agent_id: target.id,
        state: "queued",
        input: prompt,
      },
    ],
  );
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM runs WHERE conversation_id=?")
      .get(source).n,
    0,
  );
  // This fixture has no inference worker. Publish a fixture result to check
  // that the newly opened thread observes the target agent's response.
  fixture.db
    .prepare(
      "UPDATE runs SET state='completed',result=?,updated_at=? WHERE id=?",
    )
    .run(
      "Run the smoke after the current check finishes.",
      Date.now(),
      receipt.runId,
    );
  fixture.db
    .prepare(
      "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant',?,?)",
    )
    .run(
      randomUUID(),
      fixture.owner,
      receipt.id,
      receipt.runId,
      "Run the smoke after the current check finishes.",
      Date.now(),
    );
  await expect(page.locator(".conversation-sheet .messages")).toContainText(
    "Run the smoke after the current check finishes.",
  );

  // A separate, explicitly started continuation loses its acknowledgement,
  // then its destination is removed. The receipt must remain recoverable.
  fixture.db
    .prepare("UPDATE messages SET metadata='{}' WHERE conversation_id=?")
    .run(source);
  loseResponse = true;
  await page.goto(`${fixture.base}/?conversation=${source}`);
  await open();
  await dialog()
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption(target.id);
  await dialog().getByRole("checkbox").nth(0).check();
  await dialog()
    .getByRole("button", { name: "Start continuation", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Couldn’t reach Loop55",
  );
  fixture.db
    .prepare("UPDATE messages SET run_id=NULL WHERE run_id=?")
    .run(receipt.runId);
  fixture.db.prepare("DELETE FROM runs WHERE id=?").run(receipt.runId);
  fixture.db.prepare("DELETE FROM conversations WHERE id=?").run(receipt.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.reload();
    await open();
    await dialog()
      .getByRole("button", { name: "Retry continuation", exact: true })
      .click();
    await expect(dialog().getByRole("status")).toContainText(
      "This continuation was already started",
    );
    await expect(
      dialog().getByRole("button", {
        name: "Continuation unavailable",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      dialog().getByRole("textbox", {
        name: "Message to new agent",
        exact: true,
      }),
    ).toBeDisabled();
  }
  assert.equal(requests.length, 7);
  for (const request of requests.slice(5))
    assert.deepEqual(request, requests[4]);
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM continuation_requests WHERE owner_id=?")
      .get(fixture.owner).n,
    2,
  );
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM runs WHERE id=?")
      .get(receipt.runId).n,
    0,
  );
  await dialog()
    .getByRole("button", { name: "New continuation", exact: true })
    .click();
  await expect(
    dialog().getByRole("combobox", { name: "Continue with", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog().getByRole("button", { name: "Start continuation", exact: true }),
  ).toBeDisabled();
  await dialog()
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption(target.id);
  await dialog()
    .getByRole("textbox", { name: "Message to new agent", exact: true })
    .fill("Start separate work explicitly.");
  await dialog()
    .getByRole("button", { name: "Start continuation", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  assert.notEqual(
    requests[7].start.idempotencyKey,
    requests[4].start.idempotencyKey,
  );
  assert.deepEqual(
    await fixture.api(`/conversations/${source}/continue/start`, requests[4]),
    { ...receipt, unavailable: true },
  );
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM runs WHERE id=?")
      .get(receipt.runId).n,
    0,
  );
}

export async function continuationTabsSmoke(page, fixture) {
  const {
    source: sharedSource,
    target,
    insert,
    time,
    dialog,
    open,
  } = await setupContinuation(page, fixture);
  insert.run(
    randomUUID(),
    fixture.owner,
    sharedSource,
    "user",
    "Continue this question.",
    time,
  );
  // Both tabs open before either send, and both lose their acknowledgements.
  // Each must recover its own request; settling one must not erase the other.
  const secondTab = await page.context().newPage();
  const tabs = [page, secondTab].map((tab, index) => ({
    tab,
    prompt: `Continuation from tab ${index + 1}`,
    requests: [],
    receipt: null,
  }));
  for (const item of tabs) {
    await item.tab.goto(`${fixture.base}/?conversation=${sharedSource}`);
    await open(item.tab);
    await dialog(item.tab)
      .getByRole("combobox", { name: "Continue with", exact: true })
      .selectOption(target.id);
    await dialog(item.tab)
      .getByRole("textbox", { name: "Message to new agent", exact: true })
      .fill(item.prompt);
    await item.tab.route(
      `**/api/conversations/${sharedSource}/continue/start`,
      async (route) => {
        item.requests.push(route.request().postDataJSON());
        if (item.requests.length === 1) {
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          item.receipt = await response.json();
          await route.abort("failed");
        } else await route.continue();
      },
    );
  }
  for (const item of tabs) {
    await dialog(item.tab)
      .getByRole("button", { name: "Start continuation", exact: true })
      .click();
    await expect(dialog(item.tab).getByRole("alert")).toContainText(
      "Couldn’t reach Loop55",
    );
  }
  const recoveryTab = await page.context().newPage();
  await recoveryTab.goto(`${fixture.base}/?conversation=${sharedSource}`);
  await recoveryTab.evaluate(() => sessionStorage.clear());
  await recoveryTab.reload();
  await open(recoveryTab);
  const saved = dialog(recoveryTab).getByRole("combobox", {
    name: "Saved continuation requests",
    exact: true,
  });
  for (const item of tabs) {
    await saved.selectOption(item.requests[0].start.idempotencyKey);
    await expect(
      dialog(recoveryTab).getByRole("textbox", {
        name: "Message to new agent",
        exact: true,
      }),
    ).toHaveValue(item.prompt);
  }
  await recoveryTab.close();
  for (const item of [...tabs].reverse()) {
    await item.tab.reload();
    await open(item.tab);
    await expect(
      dialog(item.tab).getByRole("textbox", {
        name: "Message to new agent",
        exact: true,
      }),
    ).toHaveValue(item.prompt);
    await dialog(item.tab)
      .getByRole("button", { name: "Retry continuation", exact: true })
      .click();
    await expect(item.tab).toHaveURL(
      new RegExp(`conversation=${item.receipt.id}`),
    );
    assert.equal(item.requests.length, 2);
    assert.deepEqual(item.requests[1], item.requests[0]);
    assert.equal(
      fixture.db
        .prepare("SELECT count(*) n FROM runs WHERE conversation_id=?")
        .get(item.receipt.id).n,
      1,
    );
  }
  await secondTab.close();
}

export async function continuationLegacySmoke(page, fixture) {
  const { source, target, insert, time, dialog, open } =
    await setupContinuation(page, fixture);
  insert.run(
    randomUUID(),
    fixture.owner,
    source,
    "user",
    "Continue this question.",
    time,
  );
  const prompt = "Keep this exact custom prompt for the older workspace.";
  const requests = [];
  await page.route("**/api/capabilities", async (route) => {
    const response = await route.fetch();
    const capabilities = await response.json();
    delete capabilities.continuationStart;
    await route.fulfill({ response, json: capabilities });
  });
  await page.route(
    `**/api/conversations/${source}/continue**`,
    async (route) => {
      requests.push(route.request().url());
      await route.fulfill({
        status: 404,
        json: { error: "Update this workspace" },
      });
    },
  );
  await page.goto(`${fixture.base}/?conversation=${source}`);
  await open();
  await dialog()
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption(target.id);
  await dialog()
    .getByRole("textbox", { name: "Message to new agent", exact: true })
    .fill(prompt);
  await expect(
    dialog().getByText("Update this workspace to start continuations safely.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    dialog().getByRole("button", { name: "Start continuation", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog().getByRole("textbox", {
      name: "Message to new agent",
      exact: true,
    }),
  ).toHaveValue(prompt);
  assert.equal(requests.length, 0);
  // Even stale capabilities after a server downgrade cannot call its old,
  // non-idempotent copy endpoint. A missing start endpoint has no effect.
  await page.unroute("**/api/capabilities");
  await page.reload();
  await open();
  await dialog()
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption(target.id);
  await dialog()
    .getByRole("textbox", { name: "Message to new agent", exact: true })
    .fill(prompt);
  await dialog()
    .getByRole("button", { name: "Start continuation", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Update this workspace",
  );
  await expect(
    dialog().getByRole("textbox", {
      name: "Message to new agent",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    dialog().getByRole("textbox", {
      name: "Message to new agent",
      exact: true,
    }),
  ).toHaveValue(prompt);
  assert.deepEqual(requests, [
    `${fixture.base}/api/conversations/${source}/continue/start`,
  ]);
  assert.equal(
    fixture.db
      .prepare(
        "SELECT count(*) n FROM conversations WHERE origin='loop55-continuation'",
      )
      .get().n,
    0,
  );
}

export async function continuationRecoverySmoke(page, fixture) {
  const { source, sourceAgent, target, insert, time, dialog, open } =
    await setupContinuation(page, fixture);
  insert.run(
    randomUUID(),
    fixture.owner,
    source,
    "user",
    "Continue this question.",
    time,
  );
  const requests = [];
  await page.route(
    `**/api/conversations/${source}/continue/start`,
    async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1)
        await route.abort("failed"); // Never accepted.
      else await route.continue();
    },
  );
  await page.goto(`${fixture.base}/?conversation=${source}`);
  await open();
  await dialog()
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption(target.id);
  await dialog()
    .getByRole("textbox", { name: "Message to new agent", exact: true })
    .fill("Recover the first request.");
  // If the device cannot persist recovery state, no request is sent.
  await page.evaluate(() => {
    window.continuationSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("loop55-continuation:"))
        throw new Error("Fixture storage full");
      return window.continuationSetItem.call(this, key, value);
    };
  });
  await dialog()
    .getByRole("button", { name: "Start continuation", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Fixture storage full",
  );
  assert.equal(requests.length, 0);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.continuationSetItem;
  });
  await dialog()
    .getByRole("button", { name: "Start continuation", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(
    "Couldn’t reach Loop55",
  );
  fixture.db
    .prepare("UPDATE agents SET retired_at=? WHERE id=?")
    .run(Date.now(), target.id);
  await page.reload();
  await open();
  await dialog()
    .getByRole("button", { name: "Retry continuation", exact: true })
    .click();
  await expect(dialog().getByRole("alert")).toContainText(/retired/i);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM continuation_requests WHERE owner_id=?")
      .get(fixture.owner).n,
    0,
  );
  await dialog()
    .getByRole("button", { name: "New continuation", exact: true })
    .click();
  await expect(
    dialog().getByRole("combobox", { name: "Continue with", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog().getByRole("button", { name: "Start continuation", exact: true }),
  ).toBeDisabled();
  // The unknown request remains selectable, including in a new tab with no
  // session preference. Preparing separate work neither clears nor retries it.
  await page.reload();
  await open();
  await expect(
    dialog().getByRole("button", { name: "Start continuation", exact: true }),
  ).toBeDisabled();
  const saved = dialog().getByRole("combobox", {
    name: "Saved continuation requests",
    exact: true,
  });
  await saved.selectOption(requests[0].start.idempotencyKey);
  await expect(
    dialog().getByRole("textbox", {
      name: "Message to new agent",
      exact: true,
    }),
  ).toHaveValue("Recover the first request.");
  await dialog()
    .getByRole("button", { name: "New continuation", exact: true })
    .click();
  await dialog()
    .getByRole("combobox", { name: "Continue with", exact: true })
    .selectOption(sourceAgent.id);
  await dialog()
    .getByRole("textbox", { name: "Message to new agent", exact: true })
    .fill("Start separate work.");
  await page.evaluate(() => {
    window.continuationRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith("loop55-continuation:"))
        throw new Error("Fixture cleanup blocked");
      return window.continuationRemoveItem.call(this, key);
    };
  });
  await dialog()
    .getByRole("button", { name: "Start continuation", exact: true })
    .click();
  await expect(dialog()).toHaveCount(0);
  assert.equal(requests.length, 3);
  assert.notEqual(
    requests[2].start.idempotencyKey,
    requests[0].start.idempotencyKey,
  );
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM continuation_requests WHERE owner_id=?")
      .get(fixture.owner).n,
    1,
  );
  // Acceptance still opens the destination if recovery cleanup fails. Once
  // storage works again, its retained request recovers without another run.
  await page.evaluate(() => {
    Storage.prototype.removeItem = window.continuationRemoveItem;
  });
  const accepted = fixture.db
    .prepare(
      "SELECT conversation_id FROM continuation_requests WHERE owner_id=? AND idempotency_key=?",
    )
    .get(fixture.owner, requests[2].start.idempotencyKey);
  await expect(page).toHaveURL(
    new RegExp(`conversation=${accepted.conversation_id}`),
  );
  await page.goto(`${fixture.base}/?conversation=${source}`);
  await open();
  await dialog()
    .getByRole("combobox", { name: "Saved continuation requests", exact: true })
    .selectOption(requests[2].start.idempotencyKey);
  await dialog()
    .getByRole("button", { name: "Retry continuation", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`conversation=${accepted.conversation_id}`),
  );
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3], requests[2]);
  assert.equal(
    fixture.db
      .prepare("SELECT count(*) n FROM runs WHERE conversation_id=?")
      .get(accepted.conversation_id).n,
    1,
  );
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${fixture.base}/?conversation=${source}`);
  await open();
  await expect(
    dialog().getByRole("textbox", {
      name: "Message to new agent",
      exact: true,
    }),
  ).toHaveValue("Recover the first request.");
  await expect(
    dialog().getByRole("combobox", {
      name: "Saved continuation requests",
      exact: true,
    }),
  ).toHaveValue(requests[0].start.idempotencyKey);
}
