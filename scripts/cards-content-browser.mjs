import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { cardsFixture } from "../test/helpers/cards-fixture.ts";
import { seedCards } from "../test/helpers/seed-cards.ts";
const engine = process.env.LOOP_BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  ...(engine === chromium ? { args: ["--no-sandbox"] } : {}),
  ...(engine === chromium && process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
try {
  {
    const fixture = await cardsFixture(true);
    try {
      const { file } = await seedCards(fixture);
      const imageForm = new FormData();
      imageForm.append(
        "file",
        new Blob(
          [
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          ],
          { type: "image/png" },
        ),
        "pixel.png",
      );
      const imageUpload = await fetch(fixture.origin + "/api/uploads", {
        method: "POST",
        headers: fixture.browser,
        body: imageForm,
      });
      assert.equal(imageUpload.status, 201);
      const uploadedImage = await imageUpload.json();
      fixture.db
        .prepare("UPDATE artifacts SET pinned=1 WHERE id=?")
        .run(uploadedImage.id);
      const modelCatalog = (version) =>
        JSON.stringify([
          {
            id: "default",
            name: "Default",
            resolvedModel: "claude-opus-" + version,
          },
        ]);
      fixture.db
        .prepare(
          "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,created_at) VALUES('model-account',?,'anthropic','Model label fixture','','disconnected',?,1)",
        )
        .run(fixture.owner, modelCatalog("5-5"));
      fixture.db
        .prepare("UPDATE artifacts SET metadata=? WHERE id='result-045'")
        .run(
          JSON.stringify({
            model: "default",
            provider: "anthropic",
            connectionId: "model-account",
          }),
        );
      for (const width of [390, 1280]) {
        fixture.db
          .prepare("UPDATE connections SET models=? WHERE id='model-account'")
          .run(modelCatalog("5-5"));
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          serviceWorkers: "block",
        });
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
        const page = await context.newPage();
        const errors = [],
          reads = [];
        let holdRecovery = false,
          recoveryHeld = false,
          releaseRecovery;
        const recoveryGate = new Promise((resolve) => {
          releaseRecovery = resolve;
        });
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.method() === "GET")
            reads.push(
              new URL(request.url()).pathname + new URL(request.url()).search,
            );
        });
        try {
          // Agent Results, full body, selected text and return to loaded range.
          await page.route("**/api/v1/cards?*", async (route) => {
            if (await page.evaluate(() => !!window.__cardsManualRetry))
              return route.fallback();
            if (holdRecovery && !recoveryHeld) {
              recoveryHeld = true;
              await recoveryGate;
            }
            return route.fulfill({
              status: 503,
              json: { error: "Temporary Cards read failure" },
            });
          });
          await page.goto(fixture.origin + "/?agent=writer");
          const cards = page.locator("[data-card-id]");
          // The existing read helper exhausts two- and four-second retries
          // before surfacing a persistent server failure.
          await expect(page.getByRole("alert")).toContainText(
            "Temporary Cards read failure",
            { timeout: 10000 },
          );
          const retryCards = page.getByRole("button", {
            name: "Retry connection",
            exact: true,
          });
          // Keep automatic reads failing until the actual click. Restoring
          // the route before clicking lets a background read remove the
          // button between Playwright's visibility check and its input.
          await expect(retryCards).toBeEnabled({ timeout: 20000 });
          holdRecovery = true;
          await page.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent("loop-workspace-change", {
                detail: { sources: [""] },
              }),
            ),
          );
          await expect.poll(() => recoveryHeld, { timeout: 15000 }).toBe(true);
          await expect(page.getByRole("alert")).toContainText(
            "Temporary Cards read failure",
          );
          await expect(retryCards).toBeEnabled();
          await page.evaluate(() => {
            document.addEventListener(
              "click",
              (event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest("button")?.textContent?.trim() ===
                    "Retry connection"
                )
                  window.__cardsManualRetry = true;
              },
              { capture: true },
            );
          });
          // A refresh can replace the button during input. Repeat only when
          // no click reached the page; never repeat an observed action.
          await expect(async () => {
            if (!(await page.evaluate(() => !!window.__cardsManualRetry)))
              await retryCards.click({ timeout: 3000 });
            assert.equal(
              await page.evaluate(() => window.__cardsManualRetry),
              true,
            );
          }).toPass({ timeout: 30000 });
          await expect(cards).toHaveCount(40, { timeout: 20000 });
          releaseRecovery();
          await page.unroute("**/api/v1/cards?*");
          await page
            .getByRole("button", { name: "Earlier results", exact: true })
            .click();
          await expect(cards).toHaveCount(46);
          const first = page.locator('[data-card-id="a:result-045"]');
          await expect(first).toContainText("Claude Opus 5.5");
          await first
            .getByRole("button", { name: "View full result", exact: true })
            .click();
          await expect(page.locator(".result-sheet")).toBeVisible();
          await expect(page.locator(".result-sheet")).toContainText(
            "Claude Opus 5.5",
          );
          await expect(page.locator(".result-sheet")).toContainText(
            "End of answer 045",
          );
          await page
            .locator(".result-sheet .artifact-body")
            .evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            });
          assert(
            (
              await page.evaluate(() => window.getSelection()?.toString())
            ).includes("End of answer 045"),
          );
          await page.evaluate(() => window.getSelection()?.removeAllRanges());
          await expect(
            page.locator('.result-sheet a[href="https://example.com/"]'),
          ).toBeVisible();
          await page
            .locator(".result-sheet")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(cards).toHaveCount(46);
          fixture.db
            .prepare("UPDATE connections SET models=? WHERE id='model-account'")
            .run(modelCatalog("5-6"));
          await expect(first).toContainText("Claude Opus 5.6", {
            timeout: 20000,
          });
          await page.unroute("**/api/v1/cards**");
          await first
            .getByRole("button", { name: "Remove from Saved", exact: true })
            .click();
          await expect(
            first.getByRole("button", { name: "Save", exact: true }),
          ).toBeVisible();
          await first
            .getByRole("button", { name: "Save", exact: true })
            .click();
          await expect(
            first.getByRole("button", {
              name: "Remove from Saved",
              exact: true,
            }),
          ).toBeVisible();
          await first
            .getByRole("button", { name: "Reply", exact: true })
            .click();
          const conversation = page.locator(".conversation-sheet");
          await expect(conversation).toBeVisible();
          await conversation.locator(".composer-quote-toggle summary").click();
          await expect(
            conversation.getByRole("region", {
              name: "Original message",
              exact: true,
            }),
          ).toContainText("End of answer 045");
          await conversation
            .getByRole("textbox", { name: "Reply to agent", exact: true })
            .fill("Keep this unsent card reply");
          await conversation
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(cards).toHaveCount(46);
          await first
            .getByRole("button", { name: "Reply", exact: true })
            .click();
          await expect(
            conversation.getByRole("textbox", {
              name: "Reply to agent",
              exact: true,
            }),
          ).toHaveValue("Keep this unsent card reply");
          await conversation
            .getByRole("button", { name: "Close", exact: true })
            .click();
          // A delayed local edit response must not close a subsequently opened
          // reader or replace its contents.
          let releaseEdit, markEdited, finishEdit;
          const heldEdit = new Promise((resolve) => {
            releaseEdit = resolve;
          });
          const editCommitted = new Promise((resolve) => {
            markEdited = resolve;
          });
          const editDelivered = new Promise((resolve) => {
            finishEdit = resolve;
          });
          await page.route("**/api/artifacts/result-045", async (route) => {
            if (route.request().method() !== "PATCH") return route.continue();
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            markEdited();
            await heldEdit;
            await route.fulfill({ response });
            finishEdit();
          });
          await first
            .getByRole("button", { name: "View full result", exact: true })
            .click();
          await page.getByLabel("Result options", { exact: true }).click();
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          const editor = page.locator(".result-sheet .artifact-body textarea");
          await editor.fill(
            (await editor.inputValue()) +
              "\n\nSaved reader edit " +
              "companion" +
              width,
          );
          const editResponse = page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/artifacts/result-045") &&
              response.request().method() === "PATCH",
          );
          await page
            .getByRole("button", { name: "Save version", exact: true })
            .click();
          await editCommitted;
          await page
            .locator(".result-sheet")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await page
            .locator('[data-card-id="a:result-044"]')
            .getByRole("button", { name: "View full result", exact: true })
            .click();
          releaseEdit();
          await editDelivered;
          await (await editResponse).finished();
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          await page.unroute("**/api/artifacts/result-045");
          await expect(page.locator(".result-sheet")).toContainText(
            "End of answer 044",
          );
          await page
            .locator(".result-sheet")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(cards).toHaveCount(46);
          fixture.db
            .prepare("UPDATE artifacts SET content=? WHERE id='result-000'")
            .run("Old loaded result updated " + "companion" + width);
          await expect(
            page.locator('[data-card-id="a:result-000"]'),
          ).toContainText("Old loaded result updated " + "companion" + width, {
            timeout: 20000,
          });
          // Files remains the deliberate compatibility route.
          await page
            .getByRole("tab", { name: "Files", exact: true })
            .first()
            .click();
          await expect
            .poll(() =>
              reads.some(
                (path) =>
                  path.startsWith("/api/results?") &&
                  path.includes("view=files"),
              ),
            )
            .toBe(true);
          await expect(cards).toHaveCount(0);
          await expect(
            page.getByText("No files yet.", { exact: true }),
          ).toBeVisible();
          // Both directions must restore the selected collection even when no
          // product write or change revision occurred between tab switches.
          for (let round = 0; round < 2; round++) {
            await page
              .getByRole("tab", { name: "Results", exact: true })
              .click();
            await expect(cards).toHaveCount(46);
            await expect(
              page.locator('[data-card-id="a:result-000"]'),
            ).toContainText("Old loaded result updated " + "companion" + width);
            await page
              .getByRole("tab", { name: "Files", exact: true })
              .first()
              .click();
            await expect(cards).toHaveCount(0);
            await expect(
              page.getByText("No files yet.", { exact: true }),
            ).toBeVisible();
          }
          // The same result opens from project activity through the shared reader.
          await page.goto(
            fixture.origin + "/?page=projects&projectView=project",
          );
          await page
            .getByRole("button", { name: "Activity", exact: true })
            .click();
          await expect(cards).toHaveCount(40);
          await page
            .locator('[data-card-id="a:result-045"]')
            .getByRole("button", { name: "View full result", exact: true })
            .press("Enter");
          await expect(page.locator(".result-sheet")).toContainText(
            "End of answer 045",
          );
          await expect(page.locator(".result-sheet")).toContainText(
            "Claude Opus 5.6",
          );
          await page.getByLabel("Result options", { exact: true }).click();
          await page
            .getByRole("button", { name: "Source conversation", exact: true })
            .click();
          await expect(page.locator(".conversation-sheet")).toBeVisible();
          assert(
            reads.some(
              (path) =>
                path.startsWith("/api/v1/cards?") &&
                path.includes("project=project"),
            ),
          );
          // Saved retains loaded older history through polls, labels and Undo.
          await page.goto(fixture.origin + "/?page=profile&profileTab=saved");
          await expect(cards).toHaveCount(40);
          await page
            .getByRole("button", { name: "More saved", exact: true })
            .click();
          await expect(cards).toHaveCount(80);
          await page
            .getByRole("tab", { name: "Messages", exact: true })
            .click();
          await page.getByRole("tab", { name: "Saved", exact: true }).click();
          await expect(cards).toHaveCount(80);
          const searchSaved = page.getByRole("searchbox", {
            name: "Search Saved",
            exact: true,
          });
          await searchSaved.fill("Personal prompt");
          await expect(cards).toHaveCount(40);
          await page
            .getByRole("button", { name: "More saved", exact: true })
            .click();
          await expect(cards).toHaveCount(46);
          await page
            .getByRole("tab", { name: "Messages", exact: true })
            .click();
          await page.getByRole("tab", { name: "Saved", exact: true }).click();
          await expect(searchSaved).toHaveValue("Personal prompt");
          await expect(cards).toHaveCount(46);
          await searchSaved.fill("");
          await expect(cards).toHaveCount(80);
          const savedResult = page.locator('[data-card-id="a:result-045"]');
          await savedResult
            .getByRole("button", { name: "View full result", exact: true })
            .click();
          await expect(page.locator(".result-sheet")).toContainText(
            "End of answer 045",
          );
          await page
            .locator(".result-sheet")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(cards).toHaveCount(80);
          await savedResult
            .getByRole("button", { name: "Remove from Saved", exact: true })
            .click();
          await expect(savedResult).toHaveCount(0);
          await page.getByRole("button", { name: "Undo", exact: true }).click();
          await expect(savedResult).toBeVisible();
          const savedMessage = page.locator('[data-card-id="m:message-045"]');
          await expect(savedMessage).toContainText("Personal prompt 045");
          await expect(savedMessage).toContainText("Card conversation");
          await expect(
            savedMessage.getByRole("link", {
              name: "Open conversation",
              exact: true,
            }),
          ).toHaveAttribute("href", /conversation=thread.*message=message-045/);
          await savedMessage
            .getByRole("button", { name: "Remove from Saved", exact: true })
            .click();
          await expect(savedMessage).toHaveCount(0);
          await page
            .getByRole("searchbox", { name: "Search Saved" })
            .fill("Personal prompt 045");
          await expect(cards).toHaveCount(0);
          await page.waitForTimeout(350);
          await expect(savedMessage).toHaveCount(0);
          await page.getByRole("button", { name: "Undo", exact: true }).click();
          await expect(savedMessage).toBeVisible();
          await page.getByRole("searchbox", { name: "Search Saved" }).fill("");
          await expect(cards).toHaveCount(80);
          const savedRow = savedMessage.locator("..").locator("..");
          await savedRow
            .getByRole("button", { name: /Add a label|Edit label/ })
            .click();
          await page
            .getByLabel("Label", { exact: true })
            .fill("Chosen " + "companion" + width);
          await page
            .getByRole("button", { name: "Save label", exact: true })
            .click();
          await expect(savedRow).toContainText("Chosen " + "companion" + width);
          await expect(cards).toHaveCount(80);
          // Attachment preview uses the source-relative signed-in file route.
          await savedMessage
            .getByRole("button", { name: "Preview notes.txt", exact: true })
            .click();
          await expect(
            page
              .getByRole("dialog", { name: "notes.txt", exact: true })
              .getByText("Fixture attachment contents", { exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Close", exact: true })
            .last()
            .click();
          await savedMessage
            .getByRole("button", { name: "Preview details.txt", exact: true })
            .click();
          await expect(
            page.getByRole("dialog", { name: "details.txt", exact: true }),
          ).toContainText("Second fixture attachment");
          await page
            .getByRole("dialog", { name: "details.txt", exact: true })
            .getByRole("button", { name: "Close", exact: true })
            .click();
          // Saved file artifacts use the same typed reader with file behavior.
          const imageCard = page.locator(
            `[data-card-id="a:${uploadedImage.id}"]`,
          );
          const imagePreview = imageCard.getByRole("img", {
            name: "pixel.png",
            exact: true,
          });
          await imagePreview.scrollIntoViewIfNeeded();
          await expect(imagePreview).toHaveAttribute("src", /\/api\/objects\//);
          await expect
            .poll(() =>
              imagePreview.evaluate(
                (image) => image.complete && image.naturalWidth,
              ),
            )
            .toBe(1);
          const savedFile = page.locator(`[data-card-id="a:${file.id}"]`);
          await savedFile
            .getByRole("button", { name: "View full result", exact: true })
            .click();
          await expect(page.locator(".result-sheet")).toContainText(
            "notes.txt",
          );
          await page
            .locator(".result-sheet")
            .getByRole("button", { name: "Preview notes.txt", exact: true })
            .click();
          await expect(
            page
              .getByText("Fixture attachment contents", { exact: true })
              .last(),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Close", exact: true })
            .last()
            .click();
          await page
            .locator(".result-sheet")
            .getByRole("button", { name: "Close", exact: true })
            .click();
          // Personally sent prompts use the same Message body and attribution.
          await page
            .getByRole("tab", { name: "Messages", exact: true })
            .click();
          await expect(
            page.locator('[data-card-id="m:message-045"]'),
          ).toContainText("You sent a message to");
          await expect(
            page.locator('[data-card-id="m:message-045"]'),
          ).toContainText("Writer");
          await page
            .locator('[data-card-id="m:message-045"]')
            .getByRole("button", { name: "Reply", exact: true })
            .click();
          await expect(page.locator(".conversation-sheet")).toBeVisible();
          // Retired authors remain named; missing authors use a human fallback.
          fixture.db
            .prepare("UPDATE agents SET retired_at=1 WHERE id='writer'")
            .run();
          await page.goto(fixture.origin + "/?page=profile&profileTab=saved");
          await expect(
            page.locator('[data-card-id="a:result-045"]'),
          ).toContainText("Writer");
          fixture.db
            .prepare("UPDATE artifacts SET agent_id=NULL WHERE id='result-045'")
            .run();
          await expect(
            page.locator('[data-card-id="a:result-045"]'),
          ).toContainText("Author unavailable", { timeout: 20000 });
          fixture.db
            .prepare(
              "UPDATE artifacts SET agent_id='writer' WHERE id='result-045'",
            )
            .run();
          fixture.db
            .prepare("UPDATE agents SET retired_at=NULL WHERE id='writer'")
            .run();
          await page.reload();
          // A saved system or non-personal user record can be quoted in its
          // source thread without claiming that the owner authored it.
          const originalMessage = fixture.db
            .prepare(
              "SELECT role,metadata,content FROM messages WHERE id='message-045'",
            )
            .get();
          for (const role of ["system", "user"]) {
            fixture.db
              .prepare(
                "UPDATE messages SET role=?,content=?,metadata=json_set(metadata,'$.personal',json('false')) WHERE id='message-045'",
              )
              .run(role, "Saved " + role + " record");
            const saved = page.locator('[data-card-id="m:message-045"]');
            await expect(saved).toContainText(
              role === "system" ? "System" : "Author unavailable",
              { timeout: 20000 },
            );
            await saved
              .getByRole("button", { name: "Reply", exact: true })
              .click();
            await expect(conversation).toBeVisible();
            await expect(
              conversation.locator(".composer-quote-toggle summary"),
            ).toContainText("Replying to @Writer");
            await expect(
              conversation.locator(".composer-quote-toggle summary"),
            ).toContainText("Saved " + role + " record");
            await conversation
              .getByRole("button", { name: "Close", exact: true })
              .click();
          }
          fixture.db
            .prepare(
              "UPDATE messages SET role=?,metadata=?,content=? WHERE id='message-045'",
            )
            .run(
              originalMessage.role,
              originalMessage.metadata,
              originalMessage.content,
            );
          await page
            .getByRole("searchbox", { name: "Search Saved", exact: true })
            .fill("Nothing matches this unique query");
          await expect(
            page.getByText("Nothing saved matches", { exact: false }),
          ).toBeVisible();
          await expect(cards).toHaveCount(0);
          await page
            .getByRole("searchbox", { name: "Search Saved", exact: true })
            .fill("");
          await expect(cards).toHaveCount(40);
          assert(
            reads.some(
              (path) =>
                path.startsWith("/api/v1/cards?") && path.includes("view=sent"),
            ),
          );
          assert(
            reads.some(
              (path) =>
                path.startsWith("/api/v1/cards?") &&
                path.includes("view=saved"),
            ),
          );
          assert(
            reads.some((path) =>
              path.startsWith("/api/v1/cards/a%3Aresult-045"),
            ),
          );
          assert(
            !reads.some(
              (path) =>
                path.startsWith("/api/me/prompts") ||
                /^\/api\/saved(?:\?|$)/.test(path),
            ),
          );
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
          assert.deepEqual(errors, []);
          await page.screenshot({
            path: `/tmp/cards-content-companion-${width}.png`,
          });
          console.log(`Card content journey passed: companion, ${width}px`);
        } catch (error) {
          await page.screenshot({
            path: `/tmp/cards-content-failure-companion-${width}.png`,
            fullPage: true,
          });
          throw error;
        } finally {
          releaseRecovery();
          await context.close();
        }
      }
    } finally {
      await fixture.close();
    }
  }
} finally {
  await browser.close();
}
