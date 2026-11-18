// Uses the built UI and isolated message fixtures in Chromium and WebKit to
// check that a fenced `spec` block in an answer is drawn as a display in a Done
// card, its reading sheet, a Working card and the conversation; that a bad
// element, a block that cannot be drawn and a javascript: link degrade without
// hiding the answer; and that a display never overflows a 320 or 390px phone
// (wide tables scroll inside it). It makes no provider requests and does not
// replace physical-phone validation.
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { selectedEngines } from "./helpers/engines.mjs";
import { designFixture } from "./helpers/design-fixture.mjs";
import { trackSmokeCleanup } from "./helpers/smoke-lifecycle.mjs";
import { isWebKitNavigationFetchError } from "./helpers/browser-errors.mjs";
import { tsImport } from "tsx/esm/api";

// The design fixture completes a run without sealing its Result, which is what
// a Done card is drawn from. Seal it through the production write path.
const { publishCompletedRunResult } = await tsImport(
  "../src/server/result-publication.ts",
  import.meta.url,
);

const patch = (...lines) =>
  lines.map((line) => JSON.stringify(line)).join("\n");
const add = (key, value) => ({ op: "add", path: `/elements/${key}`, value });
const fence = (source) => "```spec\n" + source + "\n```";
const display = fence(
  patch(
    { op: "add", path: "/root", value: "card" },
    add("card", {
      type: "Card",
      props: { title: "Weekly deploys", subtitle: "Nov 9 to 15" },
      children: ["intro", "fields", "table", "button", "gone", "bad", "link"],
    }),
    add("intro", {
      type: "Text",
      props: { content: "Deploys are **up 12%** on last week." },
    }),
    add("fields", { type: "Fields", children: ["f1", "f2"] }),
    add("f1", { type: "Field", props: { label: "Deploys", value: "1,284" } }),
    add("f2", { type: "Field", props: { label: "Failures", value: 3 } }),
    add("table", {
      type: "Table",
      props: {
        headers: ["Project", "Deploys", "Failures", "Median", "Slowest"],
        rows: [["web", "412", "2", "3m 10s", "9m 02s"]],
        align: ["left", "right", "right", "right", "right"],
        caption: "By project",
      },
    }),
    add("button", {
      type: "Button",
      props: { id: "approve", label: "Approve" },
    }),
    add("gone", {
      type: "LinkButton",
      props: { label: "Do not open", url: "javascript:alert(1)" },
    }),
    add("bad", { type: "Field", props: { label: "No value" } }),
    add("link", {
      type: "Actions",
      children: ["open"],
    }),
    add("open", {
      type: "LinkButton",
      props: { label: "Open dashboard", url: "https://example.com/dash" },
    }),
  ),
);
const answer = `Here is the report.\n\n${display}\n\nTell me if you want more detail.`;
const broken = `Before the block.\n\n${fence(patch(add("orphan", { type: "Divider" })))}\n\nAfter the block.`;

for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  try {
    const browser = await engine.launch({
      headless: true,
      executablePath:
        engine === chromium ? process.env.CHROMIUM_PATH : undefined,
    });
    const closeBrowser = trackSmokeCleanup(() => browser.close());
    try {
      const done = fixture.conversations.find(
        (item) => item.state === "completed",
      );
      const working = fixture.conversations.find(
        (item) => item.state === "running",
      );
      const update = (item, text) => {
        fixture.db
          .prepare(
            "UPDATE messages SET content=? WHERE run_id=? AND role='assistant'",
          )
          .run(text, item.run);
        fixture.db
          .prepare("UPDATE artifacts SET content=? WHERE run_id=?")
          .run(text, item.run);
      };
      // Replace the answer and seal it as the run's Result (once more after
      // removing the earlier seal, which a real run never does).
      const seal = (item, text) => {
        update(item, text);
        const owner = fixture.db
          .prepare("SELECT owner_id FROM runs WHERE id=?")
          .get(item.run).owner_id;
        const id = `run:${item.run}`;
        fixture.db.exec("PRAGMA foreign_keys=OFF");
        fixture.db
          .prepare("DELETE FROM result_context_edges WHERE result_id=?")
          .run(id);
        fixture.db.prepare("DELETE FROM results WHERE id=?").run(id);
        assert(publishCompletedRunResult(item.run, owner, fixture.db));
      };
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      await fixture.pair(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => {
        if (!isWebKitNavigationFetchError(engine.name(), error, fixture.base))
          errors.push(error.message);
      });
      const requests = [];
      page.on("request", (request) => requests.push(request.url()));
      seal(done, answer);
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      const card = page
        .locator(".feed-results .feed-item-card")
        .filter({ hasText: done.title });

      await expect(card.locator(".display-spec")).toHaveCount(1);
      await expect(card.locator(".display-title")).toHaveText("Weekly deploys");
      await expect(card.locator("code.language-spec")).toHaveCount(0);

      // Reading sheet: every component, and the degraded ones.
      await card.locator(".feed-row").click();
      const reader = page.locator("dialog.feed-reading-sheet[open]");
      const shown = reader.locator(".display-spec");
      await expect(shown).toHaveCount(1);
      await expect(reader).toContainText("Here is the report.");
      await expect(reader).toContainText("Tell me if you want more detail.");
      await expect(shown.locator("strong")).toHaveText("up 12%");
      await expect(shown.locator(".display-field")).toHaveCount(2);
      await expect(
        shown
          .locator(".display-field")
          .filter({ hasText: "Deploys" })
          .locator("dd"),
      ).toHaveText("1,284");
      await expect(shown.locator("th")).toHaveCount(5);
      await expect(shown.locator("td").first()).toHaveText("web");
      await expect(
        shown.getByText("Button is not supported here"),
      ).toBeVisible();
      await expect(
        shown.getByText("This part of the display could not be shown"),
      ).toHaveCount(2);
      assert.equal(await shown.locator('a[href^="javascript"]').count(), 0);
      assert.equal(await shown.getByText("Do not open").count(), 0);
      const link = shown.getByRole("link", { name: "Open dashboard" });
      await expect(link).toHaveAttribute("href", "https://example.com/dash");
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");

      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "Page overflows at phone width",
        );
        assert(
          await reader.evaluate((el) => el.scrollWidth <= el.clientWidth),
          "Reader overflows at phone width",
        );
        assert(
          await shown.evaluate((el) => el.scrollWidth <= el.clientWidth),
          "Display overflows at phone width",
        );
        const table = shown.locator(".table-scroll");
        assert(
          await table.evaluate((el) => el.scrollWidth > el.clientWidth),
          "Wide table was not scrollable inside the display",
        );
        await table.evaluate((el) => {
          el.scrollLeft = 80;
        });
        assert(await table.evaluate((el) => el.scrollLeft > 0));
      }
      await page.screenshot({
        path: join(tmpdir(), `loop-display-${engine.name()}.png`),
      });

      // Conversation: the same display beside the original answer text.
      await reader.getByRole("button", { name: "Reply", exact: true }).click();
      const thread = page.locator("dialog.conversation-sheet[open]");
      await expect(thread.locator(".message .display-spec")).toHaveCount(1);
      await expect(thread.locator(".message .display-title")).toHaveText(
        "Weekly deploys",
      );

      // Working card: the same text drawn while the run is still working.
      update(working, answer);
      await page.goto(`${fixture.base}/?filter=working`);
      const workingRow = page
        .locator(".feed-row")
        .filter({ hasText: working.title });
      await expect(workingRow.locator(".display-spec")).toHaveCount(1);
      await workingRow.click();
      await expect(
        page.locator("dialog.feed-reading-sheet[open] .display-spec"),
      ).toHaveCount(1);

      // A block that cannot be drawn keeps the answer and shows its source.
      seal(done, broken);
      await page.goto(fixture.base);
      await page.locator(".feed-row").filter({ hasText: done.title }).click();
      const fallback = page.locator("dialog.feed-reading-sheet[open]");
      await expect(fallback).toContainText("Before the block.");
      await expect(fallback).toContainText("After the block.");
      await expect(fallback).toContainText(
        "This display could not be drawn. Its source is below.",
      );
      await expect(fallback.locator("pre code")).toContainText(
        "/elements/orphan",
      );
      await expect(fallback.locator(".display-spec")).toHaveCount(0);

      assert(
        requests.every((url) => new URL(url).origin === fixture.base),
        "A display made an external request",
      );
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `${engine.name()}: displays in Done and Working cards, reader and conversation, degraded elements, source fallback and 320/390px overflow passed`,
      );
    } finally {
      await closeBrowser();
    }
  } finally {
    await fixture.close();
  }
}
