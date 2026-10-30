// Capture README images from isolated UI fixtures; never calls a model provider.
// Run after building the UI: node scripts/readme-screenshots.mjs
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const out = root + "/docs/screenshots";
mkdirSync(out, { recursive: true });
const { designFixture } = await import(
  root + "/scripts/helpers/design-fixture.mjs"
);
const { chromium, expect } = await import(
  root + "/node_modules/@playwright/test/index.mjs"
);
const fixture = await designFixture();
const { db } = fixture;
for (const [from, to] of [
  ["scout-11eb", "bug-hunter"],
  ["scout-56f6", "test-writer"],
  ["scout-a881", "perf-tuner"],
  ["code-reviewer", "orion"],
])
  db.prepare("UPDATE agents SET name=?, normalized_name=? WHERE name=?").run(
    to,
    to,
    from,
  );
for (const { name: table } of db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE '%VIRTUAL%'",
  )
  .all())
  for (const { name: col, type } of db
    .prepare(`PRAGMA table_info("${table}")`)
    .all())
    if (/TEXT/i.test(type))
      for (const [a, b] of [
        ["code-reviewer", "orion"],
        ["gpt-6-sol", "gpt-5-codex"],
        ['"owner":"sample"', '"owner":"acme"'],
        ['"repo":"loop55"', '"repo":"storefront"'],
      ])
        db.prepare(
          `UPDATE "${table}" SET "${col}"=replace("${col}",?,?) WHERE instr("${col}",?)>0`,
        ).run(a, b, a);
for (const [from, to] of [
  ["Loop55", "Storefront"],
  ["Research and product development", "Mobile app"],
])
  db.prepare("UPDATE folders SET name=? WHERE name=? AND kind='project'").run(
    to,
    from,
  );
const rewrite = (oldTitle, title, answer) => {
  const c = fixture.conversations.find((x) => x.title === oldTitle);
  db.prepare("UPDATE conversations SET title=? WHERE id=?").run(title, c.id);
  db.prepare("UPDATE runs SET input=?, result=? WHERE id=?").run(
    title,
    answer,
    c.run,
  );
  db.prepare(
    "UPDATE messages SET content=? WHERE run_id=? AND role='user'",
  ).run(title, c.run);
  db.prepare(
    "UPDATE messages SET content=? WHERE run_id=? AND role='assistant'",
  ).run(answer, c.run);
  db.prepare("UPDATE artifacts SET title=?, content=? WHERE run_id=?").run(
    title,
    answer,
    c.run,
  );
  db.prepare("UPDATE agent_checkpoints SET output=? WHERE run_id=?").run(
    answer,
    c.run,
  );
};
rewrite(
  "Review the project navigation and agent controls before release",
  "Review pull request #42 before we ship the new checkout",
  "## Two issues before merging\n\n1. **The cart badge goes stale after checkout.** `useCart` caches the item count and nothing invalidates it when an order is placed. Invalidate it in `placeOrder`.\n2. **Empty carts are untested.** `checkout.test.ts` covers one-item and multi-item carts only.\n\nEverything else looks good: types check and all 189 tests pass.",
);
rewrite(
  "Compare the best options for our next product experiment",
  "Find why some order totals are off by a cent",
  "## Root cause\n\nLine items were summed as floating-point dollars, so three items at $0.10 came to $0.30000000000000004 and rounded down.\n\nI switched `cart/total.ts` to integer cents and added a regression test for that case. All 190 tests pass.",
);
// Keep agents, run receipts and saved result metadata on the same fixture model.
const catalog = [
  ["google/gemini-4-argon", "Gemini 4 Argon"],
  ["moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro"],
  ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["anthropic/claude-opus-5-5", "Claude Opus 5.5"],
];
const connection = db.prepare("SELECT id FROM connections LIMIT 1").get().id;
db.prepare(
  "UPDATE connections SET provider='opencode', label='OpenCode · model providers', models=?, metadata='{}' WHERE id=?",
).run(JSON.stringify(catalog.map(([id, name]) => ({ id, name }))), connection);
for (const [i, agent] of db
  .prepare("SELECT id, name FROM agents ORDER BY created_at, rowid")
  .all()
  .entries()) {
  const model =
    catalog[
      agent.name === "orion"
        ? 3
        : agent.name === "bug-hunter"
          ? 1
          : ["planner", "perf-tuner"].includes(agent.name)
            ? 2
            : i % 3
    ][0];
  db.prepare(
    "UPDATE agents SET provider='opencode', connection_id=?, model=? WHERE id=?",
  ).run(connection, model, agent.id);
  db.prepare(
    "UPDATE runs SET payload=json_set(payload,'$.connectionId',?,'$.provider','opencode','$.model',?) WHERE agent_id=?",
  ).run(connection, model, agent.id);
  db.prepare(
    "UPDATE artifacts SET metadata=json_set(COALESCE(metadata,'{}'),'$.connectionId',?,'$.provider','opencode','$.model',?) WHERE agent_id=?",
  ).run(connection, model, agent.id);
}
db.prepare(
  "UPDATE messages SET metadata=json_set(COALESCE(metadata,'{}'),'$.personal',1) WHERE role='user'",
).run();
db.prepare(
  "INSERT INTO user_profiles(owner_id,display_name,handle,bio,updated_at) VALUES(?,?,?,?,?)",
).run(
  fixture.owner,
  "Alex Rivera",
  "alex",
  "Shipping a storefront with a small team of agents.",
  Date.now(),
);
const { seedCheckout } = await import(
  root + "/scripts/helpers/checkout-fixture.mjs"
);
const { randomUUID } = await import("node:crypto");
const fix = fixture.conversations.find(
  (x) => x.title === "Compare the best options for our next product experiment",
);
const review = fixture.conversations.find(
  (x) =>
    x.title ===
    "Review the project navigation and agent controls before release",
);
{
  const files = [
    { path: "src/cart/total.ts", additions: 6, deletions: 4, binary: false },
    {
      path: "src/cart/total.test.ts",
      additions: 9,
      deletions: 0,
      binary: false,
    },
  ];
  const patch = [
    "diff --git a/src/cart/total.ts b/src/cart/total.ts",
    "--- a/src/cart/total.ts",
    "+++ b/src/cart/total.ts",
    "@@ -1,8 +1,10 @@",
    "-export function orderTotal(items: LineItem[]): number {",
    "-  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
    "-  return Math.floor(total * 100) / 100;",
    "-}",
    "+// Prices are integer cents; floating-point dollars lose a cent on some sums.",
    "+export function orderTotalCents(items: LineItem[]): number {",
    "+  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);",
    "+}",
    "+",
    "+export const formatTotal = (cents: number) => `$${(cents / 100).toFixed(2)}`;",
    "diff --git a/src/cart/total.test.ts b/src/cart/total.test.ts",
    "--- a/src/cart/total.test.ts",
    "+++ b/src/cart/total.test.ts",
    "@@ -20,0 +21,9 @@",
    '+test("three items at $0.10 total $0.30", () => {',
    "+  const items = Array.from({ length: 3 }, () => ({ priceCents: 10, quantity: 1 }));",
    "+  expect(orderTotalCents(items)).toBe(30);",
    '+  expect(formatTotal(orderTotalCents(items))).toBe("$0.30");',
    "+});",
    "+",
    '+test("an empty cart totals zero", () => {',
    "+  expect(orderTotalCents([])).toBe(0);",
    "+});",
    "",
  ].join("\n");
  seedCheckout(db, fix.run, { files, patch });
  db.prepare(
    "UPDATE run_checkouts SET branch='fix/order-total-cents', summary=json_set(summary,'$.branch','fix/order-total-cents') WHERE run_id=?",
  ).run(fix.run);
  const check = (command, kind, out) =>
    db
      .prepare(
        `INSERT INTO run_verifications(
      id,owner_id,run_id,conversation_id,source_id,kind,tools,command,status,exit_code,output_tail,observed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        fixture.owner,
        fix.run,
        fix.id,
        randomUUID(),
        kind,
        JSON.stringify([command]),
        command,
        "passed",
        0,
        out,
        Date.now(),
      );
  check(
    "npm test",
    "test",
    " Test Files  36 passed (36)\n      Tests  190 passed (190)",
  );
  check("npm run typecheck", "typecheck", "> tsc --noEmit");
  check("npm run lint", "lint", "> eslint .");
  const conv = db
    .prepare("SELECT agent_id FROM conversations WHERE id=?")
    .get(fix.id);
  const sha = "c0ffee".padEnd(40, "1");
  db.prepare(
    "INSERT INTO pr_watches(id,owner_id,conversation_id,agent_id,repo_owner,repo_name,number,state,head_sha,ci_sha,ci_conclusion,since_at,next_poll_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'watching',?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    fixture.owner,
    fix.id,
    conv.agent_id,
    "acme",
    "storefront",
    43,
    sha,
    sha,
    "success",
    Date.now(),
    Date.now() + 864e5,
    Date.now(),
    Date.now(),
  );
}
for (const item of [review, fix]) {
  const m = db
    .prepare("SELECT id FROM messages WHERE run_id=? AND role='assistant'")
    .get(item.run);
  await fixture.api(`/messages/${m.id}/saved`, {});
}
{
  const saved = await fixture.api("/saved");
  const items = saved.items ?? saved;
  for (const it of items) {
    const label = /cent|Root cause/.test(JSON.stringify(it))
      ? "Rounding fix"
      : "Review before merge";
    await fixture
      .api("/saved/label", { key: it.key, label }, "PUT")
      .catch((e) => console.error("label", e.message));
  }
}
{
  const store = db
    .prepare(
      "SELECT id FROM folders WHERE name='Storefront' AND kind='project'",
    )
    .get().id;
  for (const { name: table } of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE '%VIRTUAL%'",
    )
    .all()) {
    const cols = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((c) => c.name);
    if (cols.includes("folder_id") && cols.includes("conversation_id"))
      db.prepare(
        `UPDATE "${table}" SET folder_id=? WHERE conversation_id=?`,
      ).run(store, review.id);
    if (table === "conversations" && cols.includes("project_id"))
      db.prepare(`UPDATE conversations SET project_id=? WHERE id=?`).run(
        store,
        review.id,
      );
  }
}
db.prepare("UPDATE agents SET instructions=? WHERE name='orion'").run(
  "The unexamined loop is not worth repeating.",
);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const capture = async (name) => {
    const { summary } = await fixture.api("/feed?filter=needs");
    const total =
      summary.working +
      summary.queued +
      (summary.replies_unread || 0) +
      (summary.done_unread || 0);
    const badge = page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Feed", exact: true })
      .locator("small");
    if (total)
      await expect(badge).toHaveAttribute(
        "aria-label",
        `${total} ${total === 1 ? "item" : "items"} in Feed`,
      );
    else await expect(badge).toHaveCount(0);
    await page.screenshot({ path: out + "/" + name + ".png" });
  };
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await capture("needs-you");
  await page.evaluate(() => {
    const done = [...document.querySelectorAll("button, [role=tab]")].find(
      (b) => /Done/.test(b.textContent),
    );
    done.scrollIntoView({ block: "start" });
    window.scrollBy(0, -12);
  });
  await page.waitForTimeout(800);
  await capture("feed");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .locator(".your-agents .agent-strip button")
    .filter({ hasText: "orion" })
    .click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page
    .locator(".profile-model")
    .filter({ hasText: "Claude Opus 5.5" })
    .waitFor();
  await capture("agent-profile");
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Your profile", exact: true })
    .click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await capture("your-profile");
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(600);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page
    .locator(".my-profile-tabs")
    .getByRole("tab", { name: "Saved" })
    .or(
      page.locator(".my-profile-tabs").getByRole("button", { name: /^Saved/ }),
    )
    .first()
    .click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollBy(0, 515));
  await page.waitForTimeout(500);
  await capture("saved");
  await page.goto(fixture.base + "/?filter=done", { waitUntil: "networkidle" });
  await page
    .locator(".inbox-results .inbox-card")
    .filter({ hasText: "off by a cent" })
    .locator(".inbox-row")
    .click();
  const reader = page.locator("dialog.feed-reading-sheet[open]");
  await reader.waitFor();
  await page.waitForTimeout(1000);
  await capture("result");
} finally {
  await browser.close();
  await fixture.close();
}
process.exit(0);
