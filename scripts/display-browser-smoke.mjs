// Uses the built UI and isolated message fixtures in Chromium and WebKit to
// check that a fenced `spec` block in an answer is drawn as a display in a Done
// card, its reading sheet, a Working card and the conversation; that a bad
// element, a block that cannot be drawn and a javascript: link degrade without
// hiding the answer; and that a display never overflows a 320 or 390px phone
// (wide tables scroll inside it). Charts: each type is drawn as a named SVG
// that fits the phone, category labels do not overlap, and the numbers are in
// a table under the chart. While a run works, the Working card draws an open
// block as far as it is written ("Display loading…", then part, then all),
// never shows its JSON, keeps the conversation link when the text is cut at
// 4,000 characters, and the finished run's Done card shows the whole display.
// Fixture writes drive the mounted completion check; earlier progress uses
// reloads. Set
// LOOP_SCREENSHOT_DIR to save light and
// dark screenshots. It makes no provider requests and does not replace
// physical-phone validation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { smokeScreenshotDirectory } from "./helpers/smoke-diagnostics.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";
import { chromiumExecutable, selectedEngines } from "./helpers/engines.mjs";
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
const months = [
  "January 2026",
  "February 2026",
  "March 2026",
  "April 2026",
  "May 2026",
  "June 2026",
  "July 2026",
  "August 2026",
  "September 2026",
  "October 2026",
  "November 2026",
  "December 2026",
];
const charts = fence(
  patch(
    { op: "add", path: "/root", value: "card" },
    add("card", {
      type: "Card",
      props: { title: "Deploy charts" },
      children: ["bar", "line", "area", "pie"],
    }),
    add("bar", {
      type: "Chart",
      props: {
        title: "Deploys by month",
        chart: {
          type: "bar",
          categories: months,
          series: ["web", "api", "jobs", "docs", "cli"].map((name, s) => ({
            name,
            values: months.map((_, i) => ((i * 7 + s * 13) % 40) + 5),
          })),
          xLabel: "Month",
          yLabel: "Deploys",
        },
      },
    }),
    add("line", {
      type: "Chart",
      props: {
        title: "Median build minutes",
        chart: {
          type: "line",
          categories: ["Mon", "Tue", "Wed", "Thu", "Fri"],
          series: [
            { name: "main", values: [12.5, 11, 13.25, 9, 10] },
            { name: "release", values: [-2, 4, 6, 3, 8] },
          ],
        },
      },
    }),
    add("area", {
      type: "Chart",
      props: {
        title: "Queue depth",
        chart: {
          type: "area",
          categories: ["1", "2", "3", "4", "5", "6"],
          series: [{ name: "jobs", values: [0, 4, 9, 6, 2, 0] }],
        },
      },
    }),
    add("pie", {
      type: "Chart",
      props: {
        title: "Deploys by project",
        chart: {
          type: "pie",
          segments: [
            { label: "web", value: 412 },
            { label: "api", value: 288 },
            { label: "jobs", value: 97 },
          ],
        },
      },
    }),
  ),
);
const chartAnswer = `Charts for the week.\n\n${charts}`;
const shots = smokeScreenshotDirectory("LOOP_DISPLAY_SCREENSHOT_DIR", {
  ciDefault: false,
});
const answer = `Here is the report.\n\n${display}\n\nTell me if you want more detail.`;
// One answer at three points while it is written: the root only, half the
// elements (the last line cut mid-way), and the whole closed block.
const written = display.slice("```spec\n".length, -"\n```".length).split("\n");
const intro = "Here is the report.\n\n```spec\n";
const writingSteps = [
  ["loading", intro + written[0] + "\n" + written[1].slice(0, 30)],
  [
    "partial",
    intro + written.slice(0, 6).join("\n") + "\n" + written[6].slice(0, 25),
  ],
  ["complete", answer],
];
const broken = `Before the block.\n\n${fence(patch(add("orphan", { type: "Divider" })))}\n\nAfter the block.`;

for (const engine of selectedEngines()) {
  const fixture = await designFixture();
  try {
    const browser = await engine.launch({
      headless: true,
      executablePath: chromiumExecutable(engine),
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

      // A readable API response must also survive Markdown render failures.
      const malformed =
        "Summary.\n\n" +
        "> ".repeat(10000) +
        "```spec\n" +
        "> ".repeat(10000) +
        '{"op":"add"}';
      seal(done, malformed);
      await page.reload({ waitUntil: "networkidle" });
      await expect(card.locator(".markdown-fallback")).toBeVisible();
      await expect(card.locator(".markdown-fallback")).toContainText(
        "Open it to read the text.",
      );
      await expect(card.locator(".markdown-fallback")).not.toContainText(
        '"op"',
      );
      await expect(card.locator(".markdown-fallback pre")).toHaveCount(0);
      await card.evaluate((element) => {
        element.dataset.recoveryProbe = "mounted";
      });
      await card.locator(".feed-row").click();
      const failedReader = page.locator("dialog.feed-reading-sheet[open]");
      await expect(failedReader.locator(".markdown-fallback")).toBeVisible();
      assert.equal(
        await failedReader.locator(".markdown-fallback pre").textContent(),
        malformed,
      );
      await failedReader
        .getByRole("button", { name: "Close", exact: true })
        .click();
      seal(done, answer);
      await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
      await expect(card.locator(".display-title")).toHaveText("Weekly deploys");
      await expect(card.locator(".markdown-fallback")).toHaveCount(0);
      await expect(card).toHaveAttribute("data-recovery-probe", "mounted");

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
        path: join(shots ?? tmpdir(), `loop-display-${engine.name()}.png`),
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

      // A display drawn while it is written, then finished.
      const workingCard = () =>
        page
          .locator(".feed-results .feed-item-card")
          .filter({ hasText: working.title });
      for (const [step, text] of writingSteps) {
        update(working, text);
        await page.goto(`${fixture.base}/?filter=working`, {
          waitUntil: "networkidle",
        });
        const live = workingCard().locator(".live-preview");
        await expect(live).toBeVisible();
        if (step === "loading") {
          await expect(live.locator(".display-loading")).toHaveText(
            "Display loading…",
          );
          await expect(live.locator(".display-spec")).toHaveCount(0);
        } else {
          await expect(live.locator(".display-spec")).toHaveCount(1);
          await expect(live.locator(".display-title")).toHaveText(
            "Weekly deploys",
          );
          await expect(live.locator(".display-loading")).toHaveCount(0);
        }
        if (step === "partial") {
          await expect(live.locator(".display-field")).toHaveCount(2);
          await expect(live.locator(".display-placeholder")).toHaveCount(0);
          await expect(live.locator(".table-scroll")).toHaveCount(0);
        }
        if (step === "complete")
          await expect(live.locator(".display-link-button")).toHaveText(
            "Open dashboard",
          );
        const shown = await workingCard().innerText();
        assert(!shown.includes('{"op"'), `Working card showed JSON (${step})`);
        assert(!shown.includes("could not be drawn"), step);
        if (shots)
          for (const scheme of ["light", "dark"]) {
            await page.emulateMedia({ colorScheme: scheme });
            await workingCard().screenshot({
              path: join(
                shots,
                `${engine.name()}-working-${step}-${scheme}.png`,
              ),
            });
          }
        await page.emulateMedia({ colorScheme: "light" });
      }
      update(working, "    ```spec\n    An indented code example");
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().locator(".live-preview pre")).toContainText(
        "An indented code example",
      );
      await expect(workingCard().locator(".display-loading")).toHaveCount(0);

      // The reading sheet and the conversation draw the open block the same
      // way while the run works.
      update(working, writingSteps[1][1]);
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await workingCard().locator(".feed-row").click();
      const workingSheet = page.locator("dialog.feed-reading-sheet[open]");
      await expect(workingSheet.locator(".display-field")).toHaveCount(2);
      await expect(workingSheet.locator(".display-placeholder")).toHaveCount(0);
      await workingSheet
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      const workingThread = page.locator("dialog.conversation-sheet[open]");
      await expect(
        workingThread.locator(".message .display-field"),
      ).toHaveCount(2);
      await expect(
        workingThread.locator(".message .display-placeholder"),
      ).toHaveCount(0);

      // Cut at 4,000 characters: drawn as an open block, with the link on.
      const long =
        "Background. ".repeat(320) +
        "\n\n" +
        answer.replace("Here is the report.\n\n", "");
      update(working, long);
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await workingCard().locator(".feed-row").click();
      const cutSheet = page.locator("dialog.feed-reading-sheet[open]");
      await expect(
        cutSheet.getByText("Continue reading in conversation"),
      ).toBeVisible();
      assert(!(await cutSheet.innerText()).includes('{"op"'));
      assert(!(await cutSheet.innerText()).includes("could not be drawn"));

      // A cap that cuts off the suffix of a fence-like content line
      // must not turn it into an apparent closing fence.
      const rootOnly =
        "```spec\n" +
        patch({
          op: "add",
          path: "/root",
          value: "pending",
        }) +
        "\n";
      update(
        working,
        rootOnly + " ".repeat(4000 - rootOnly.length - 4) + "\n```draft",
      );
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().getByText("Display loading…")).toBeVisible();
      await workingCard().locator(".feed-row").click();
      await expect(cutSheet.getByText("Display loading…")).toBeVisible();
      await expect(
        cutSheet.getByText("Continue reading in conversation"),
      ).toBeVisible();
      await expect(cutSheet.locator("code.language-spec")).toHaveCount(0);

      const genuineCloser =
        rootOnly + " ".repeat(4000 - rootOnly.length - 4) + "\n```";
      for (const full of [
        genuineCloser,
        genuineCloser + "\nAfter.",
        genuineCloser + "`",
      ]) {
        update(working, full);
        await page.goto(`${fixture.base}/?filter=working`, {
          waitUntil: "networkidle",
        });
        await expect(workingCard().locator(".live-preview")).toContainText(
          "This display could not be drawn.",
        );
        await workingCard().locator(".feed-row").click();
        await expect(cutSheet).toContainText(
          "This display could not be drawn.",
        );
      }

      // The preview cap can keep only three of a four-backtick closer.
      // The Working preview stays open until the full answer is opened.
      const fourBacktickRoot = "`" + rootOnly;
      update(
        working,
        fourBacktickRoot +
          " ".repeat(4000 - fourBacktickRoot.length - 4) +
          "\n````",
      );
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().getByText("Display loading…")).toBeVisible();
      await workingCard().locator(".feed-row").click();
      await expect(
        cutSheet.getByText("Continue reading in conversation"),
      ).toBeVisible();

      // A nonbreaking space keeps a delimiter-like line inside the fence.
      update(working, rootOnly + "```\u00a0");
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().getByText("Display loading…")).toBeVisible();
      await workingCard().locator(".feed-row").click();
      await expect(cutSheet.getByText("Display loading…")).toBeVisible();
      await expect(cutSheet.locator("code.language-spec")).toHaveCount(0);

      update(working, "\n".repeat(3999) + "Deployment succeeded.");
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().locator(".live-preview")).toContainText(
        "Deployment succeeded.",
      );
      await workingCard().locator(".feed-row").click();
      await expect(cutSheet).toContainText("Deployment succeeded.");

      update(working, " ".repeat(4000) + "Visible after whitespace.");
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().locator(".live-preview pre")).toContainText(
        "Visible after whitespace.",
      );
      await workingCard().locator(".feed-row").click();
      await expect(cutSheet.locator("pre")).toContainText(
        "Visible after whitespace.",
      );

      update(
        working,
        "\u00a0" + " ".repeat(3999) + "Ready after unicode spaces.",
      );
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().locator(".live-preview")).toContainText(
        "Ready after unicode spaces.",
      );

      update(working, "\u00a0" + " ".repeat(3999) + "```spec");
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().locator(".live-preview")).toContainText(
        "```spec",
      );
      await expect(workingCard().locator(".display-loading")).toHaveCount(0);

      for (const [clipped, remainder] of [
        ["```spec", "imen\nordinary example"],
        ["```spec", " example `invalid"],
        ["```spec note\u2028", "`invalid"],
        ["```spec", " " + "x".repeat(4000) + "`invalid"],
        ["```spec", " " + "x".repeat(4001) + "\n"],
      ]) {
        const prose = "Text. " + "x".repeat(4000 - 8 - clipped.length) + "\n\n";
        update(working, prose + clipped + remainder);
        await page.goto(`${fixture.base}/?filter=working`, {
          waitUntil: "networkidle",
        });
        await expect(
          workingCard().locator(".live-preview code.language-text"),
        ).toHaveCount(1);
        await expect(workingCard().locator(".display-loading")).toHaveCount(0);
        await workingCard().locator(".feed-row").click();
        await expect(cutSheet.locator("code.language-text")).toHaveCount(1);
        await expect(cutSheet.locator(".display-loading")).toHaveCount(0);
      }

      // A complete-looking patch at the cap can still have an invalid suffix.
      const replacement = fence(
        patch(
          { op: "add", path: "/root", value: "card" },
          add("card", { type: "Card", props: { title: "Earlier title" } }),
          {
            op: "replace",
            path: "/elements/card",
            value: { type: "Card", props: { title: "Clipped title" } },
          },
        ),
      ).slice(0, -4);
      const padded =
        "Text. " +
        "x".repeat(4000 - 8 - replacement.length) +
        "\n\n" +
        replacement;
      update(working, padded + " invalid\n```");
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().locator(".display-title")).toHaveText(
        "Earlier title",
      );
      await workingCard().locator(".feed-row").click();
      await expect(cutSheet.locator(".display-title")).toHaveText(
        "Earlier title",
      );
      update(working, padded + "\n```");
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(workingCard().locator(".display-title")).toHaveText(
        "Clipped title",
      );
      await workingCard().locator(".feed-row").click();
      await expect(cutSheet.locator(".display-title")).toHaveText(
        "Clipped title",
      );

      // The renderer recognizes both forms of whitespace in the language token.
      for (const [encodedOpener, continuation] of [
        ["```spec", "&#32;extra"],
        ["```spec", "\u00a0extra"],
        ["```sp", "ec"],
        ["```", "spec"],
        ["```", "`spec"],
        ["~~~", "~spec"],
        ["- ```", "spec"],
      ]) {
        update(
          working,
          "Text. " +
            "x".repeat(4000 - 8 - encodedOpener.length) +
            "\n\n" +
            encodedOpener +
            continuation +
            "\n",
        );
        await page.goto(`${fixture.base}/?filter=working`, {
          waitUntil: "networkidle",
        });
        await expect(workingCard().getByText("Display loading…")).toBeVisible();
        await workingCard().locator(".feed-row").click();
        await expect(cutSheet.getByText("Display loading…")).toBeVisible();
      }
      const ordinaryFenceAtCut = "```javascript\n```";
      update(
        working,
        "Text. " +
          "x".repeat(4000 - 8 - ordinaryFenceAtCut.length) +
          "\n\n" +
          ordinaryFenceAtCut +
          "spec\nordinary code\n```",
      );
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await expect(
        workingCard().locator(".live-preview code.language-javascript"),
      ).toHaveCount(1);
      await expect(workingCard().locator(".display-loading")).toHaveCount(0);
      await workingCard().locator(".feed-row").click();
      await expect(cutSheet.locator("code.language-javascript")).toHaveCount(1);
      await expect(cutSheet.locator(".display-loading")).toHaveCount(0);

      // Earlier progress messages are final while the latest is still growing.
      const progress = fixture.db.prepare(
        "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,metadata,created_at) SELECT ?,owner_id,conversation_id,run_id,'assistant',?,?,created_at+? FROM messages WHERE run_id=? AND role='assistant' ORDER BY created_at LIMIT 1",
      );
      const earlierUpdate = randomUUID();
      const currentUpdate = randomUUID();
      progress.run(
        earlierUpdate,
        "Earlier update.\n\n" + rootOnly,
        '{"progress":true}',
        1,
        working.run,
      );
      progress.run(
        currentUpdate,
        "Current update.\n\n" + rootOnly,
        '{"progress":true}',
        2,
        working.run,
      );
      // Move an older fixture prompt into this conversation while retaining
      // its earlier transcript sequence, independent of the active run.
      const priorPrompt = fixture.db
        .prepare("SELECT id FROM messages WHERE run_id=? AND role='user'")
        .get(done.run).id;
      fixture.db
        .prepare(
          "UPDATE messages SET conversation_id=?,run_id=NULL,content=? WHERE id=?",
        )
        .run(working.id, "Earlier fixture prompt.", priorPrompt);
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await workingCard().locator(".feed-row").click();
      await workingSheet
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      const updates = workingThread.locator(".agent-progress");
      await expect(
        updates.filter({ hasText: "Earlier update." }),
      ).toContainText("This display could not be drawn.");
      await expect(
        updates.filter({ hasText: "Current update." }),
      ).toContainText("Display loading…");
      const transcriptPath = `/api/conversations/${working.id}`;
      const recoveryRead = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === transcriptPath &&
          url.searchParams.get("message") === priorPrompt
        );
      });
      // A non-append replacement beyond the event budget forces a recovery
      // read of this older message while the live progress row is retained.
      fixture.db
        .prepare("UPDATE messages SET content=? WHERE id=?")
        .run("Recovered earlier prompt. " + "x".repeat(70_000), priorPrompt);
      const recoveryPage = await (await recoveryRead).json();
      assert.deepEqual(
        recoveryPage.latest_progress_messages.map(({ id }) => id),
        [currentUpdate],
      );
      await expect(
        workingThread.getByText(/Recovered earlier prompt/),
      ).toBeVisible();
      await expect(
        updates.filter({ hasText: "Current update." }),
      ).toContainText("Display loading…");
      fixture.db
        .prepare(
          "UPDATE messages SET conversation_id=?,run_id=?,content=? WHERE id=?",
        )
        .run(done.id, done.run, done.title, priorPrompt);
      for (const [anchor, label, displayState] of [
        [earlierUpdate, "Earlier update.", "This display could not be drawn."],
        [currentUpdate, "Current update.", "Display loading…"],
      ]) {
        const anchoredRead = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === transcriptPath &&
            url.searchParams.get("message") === anchor
          );
        });
        // Observe the anchored snapshot before the tail recovery read.
        await page.route(
          (url) =>
            url.pathname === transcriptPath &&
            url.searchParams.get("message") !== anchor,
          (route) => route.abort(),
        );
        await page.goto(
          `${fixture.base}/?conversation=${working.id}&message=${anchor}`,
          { waitUntil: "domcontentloaded" },
        );
        const anchoredPage = await (await anchoredRead).json();
        assert(anchoredPage.messages.some((message) => message.id === anchor));
        assert.equal(
          anchoredPage.messages.some((message) => message.id === currentUpdate),
          anchor === currentUpdate,
        );
        assert.notEqual(anchoredPage.latest_agent_message.id, currentUpdate);
        await expect(updates.filter({ hasText: label })).toContainText(
          displayState,
        );
        if (anchor === currentUpdate)
          await expect(
            updates.filter({ hasText: label }).locator("code.language-spec"),
          ).toHaveCount(0);
        await page.unrouteAll({ behavior: "wait" });
      }
      // New progress sorts before the ordinary answer, so an answer anchor
      // can absorb it through events without fetching a newer page.
      const answerAnchor = fixture.db
        .prepare(
          "SELECT id FROM messages WHERE run_id=? AND role='assistant' AND json_extract(metadata,'$.progress') IS NOT 1",
        )
        .get(working.run).id;
      await page.route(
        (url) =>
          url.pathname === transcriptPath &&
          url.searchParams.get("message") !== answerAnchor,
        (route) => route.abort(),
      );
      await page.goto(
        `${fixture.base}/?conversation=${working.id}&message=${answerAnchor}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(
        updates.filter({ hasText: "Current update." }),
      ).toContainText("Display loading…");
      const newerUpdate = randomUUID();
      progress.run(
        newerUpdate,
        "Newer live update.\n\n" + rootOnly,
        '{"progress":true}',
        3,
        working.run,
      );
      await expect(
        updates.filter({ hasText: "Newer live update." }),
      ).toContainText("Display loading…");
      await expect(
        updates.filter({ hasText: "Current update." }),
      ).toContainText("This display could not be drawn.");
      await page.unrouteAll({ behavior: "wait" });
      fixture.db
        .prepare("DELETE FROM messages WHERE id IN (?, ?, ?)")
        .run(earlierUpdate, currentUpdate, newerUpdate);

      // Keep the conversation mounted while a run with a chart finishes.
      // The incomplete block proves the writing state reached this view.
      update(
        working,
        `${charts}\n\n\`\`\`spec\n${patch({
          op: "add",
          path: "/root",
          value: "pending",
        })}`,
      );
      await page.goto(`${fixture.base}/?filter=working`, {
        waitUntil: "networkidle",
      });
      await workingCard().locator(".feed-row").click();
      await workingSheet
        .getByRole("button", { name: "Reply", exact: true })
        .click();
      await expect(workingThread.getByText("Display loading…")).toBeVisible();
      const disclosure = workingThread
        .locator(".display-chart-numbers")
        .first();
      await disclosure.locator("summary").click();
      await expect(disclosure).toHaveAttribute("open", "");
      fixture.db
        .prepare("UPDATE runs SET state='completed' WHERE id=?")
        .run(working.run);
      await expect(
        workingThread.getByText(
          "This display could not be drawn. Its source is below.",
        ),
      ).toBeVisible();
      await expect(disclosure).toHaveAttribute("open", "");

      // The run's Done card shows the full fixture answer after sealing.
      seal(working, answer);
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      const finished = page
        .locator(".feed-results .feed-item-card")
        .filter({ hasText: working.title });
      await expect(finished.locator(".display-spec")).toHaveCount(1);
      await expect(finished.locator(".display-loading")).toHaveCount(0);
      if (shots)
        for (const scheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme: scheme });
          await finished.screenshot({
            path: join(shots, `${engine.name()}-finished-done-${scheme}.png`),
          });
        }
      await page.emulateMedia({ colorScheme: "light" });

      // Charts: each type drawn as a named SVG that fits the phone, with its
      // numbers in a table.
      seal(done, chartAnswer);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      const chartCard = page
        .locator(".feed-results .feed-item-card")
        .filter({ hasText: done.title });
      await expect(
        chartCard.locator(".display-chart-svg").first(),
      ).toBeVisible();
      if (shots)
        for (const scheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme: scheme });
          await chartCard.screenshot({
            path: join(shots, `${engine.name()}-chart-card-${scheme}.png`),
          });
        }
      await chartCard.locator(".feed-row").click();
      const chartSheet = page.locator("dialog.feed-reading-sheet[open]");
      const figures = chartSheet.locator(".display-chart");
      await expect(figures).toHaveCount(4);
      for (const [name, kind] of [
        ["Deploys by month", "Bar chart, 5 series, 12 categories"],
        ["Median build minutes", "Line chart, 2 series, 5 categories"],
        ["Queue depth", "Area chart, 1 series, 6 categories"],
        ["Deploys by project", "Pie chart, 3 segments"],
      ])
        await expect(
          chartSheet.getByRole("img", {
            name: `${name}. ${kind}.`,
            exact: false,
          }),
        ).toBeVisible();
      await expect(
        figures.first().locator(".display-chart-legend li"),
      ).toHaveCount(5);
      await expect(chartSheet.getByText("web 52%")).toBeVisible();
      if (shots)
        for (const scheme of ["light", "dark"]) {
          await page.emulateMedia({ colorScheme: scheme });
          for (const [index, name] of [
            "bar",
            "line",
            "area",
            "pie",
          ].entries()) {
            await figures.nth(index).scrollIntoViewIfNeeded();
            await figures.nth(index).screenshot({
              path: join(shots, `${engine.name()}-chart-${name}-${scheme}.png`),
            });
          }
        }
      await page.emulateMedia({ colorScheme: "light" });
      // Open the table first: it must scroll inside the display, not widen it.
      const numbers = figures.first().locator("details");
      await numbers.locator("summary").click();
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "Page overflows with charts at phone width",
        );
        for (const svg of await chartSheet
          .locator(".display-chart-svg")
          .all()) {
          const fits = await svg.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const parent = el.closest(".display-spec").getBoundingClientRect();
            return (
              box.left >= parent.left - 0.5 && box.right <= parent.right + 0.5
            );
          });
          assert(fits, "A chart is wider than its display");
        }
        const overlap = await chartSheet
          .locator(".display-chart-categories")
          .first()
          .evaluate((group) => {
            const boxes = [...group.querySelectorAll("text")].map((t) =>
              t.getBoundingClientRect(),
            );
            return boxes.some(
              (box, i) => i > 0 && box.left < boxes[i - 1].right - 0.5,
            );
          });
        assert(!overlap, `Category labels overlap at ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        numbers
          .locator("tr")
          .filter({ hasText: "September 2026" })
          .locator("td"),
      ).toHaveText(["21", "34", "7", "20", "33"]);

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
        `${engine.name()}: displays in Done and Working cards, reader and conversation, degraded elements, displays while written, charts, source fallback and 320/390px overflow passed`,
      );
    } finally {
      await closeBrowser();
    }
  } finally {
    await fixture.close();
  }
}
