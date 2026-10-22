import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

// Exercise real input handling with a full Feed and a long conversation. No
// provider is called; the only changing input during measurement is the draft.
export async function composerTypingSmoke(page, fixture, engine, capture) {
  const paragraph =
    "The composer should stay responsive while the agent reviews **the current changes**, preserves the [source](https://example.com/review), and reports what still needs attention.\n\n";
  const content =
    "## Review report\n\n" +
    paragraph.repeat(12) +
    "| Component | Status |\n| --- | --- |\n" +
    "| Composer | Checked |\n".repeat(15);
  let conversation, lastMessage;
  fixture.db.transaction(() => {
    for (let i = 0; i < 24; i++) {
      const cid = randomUUID(),
        rid = randomUUID(),
        agent = fixture.agents[0],
        time = Date.now() + i;
      conversation = cid;
      fixture.db
        .prepare(
          "INSERT INTO conversations(id,owner_id,agent_id,title,created_at) VALUES(?,?,?,?,?)",
        )
        .run(cid, fixture.owner, agent.id, "Typing report " + i, time);
      fixture.db
        .prepare(
          "INSERT INTO runs(id,owner_id,agent_id,conversation_id,input,state,idempotency_key,payload,result,created_at,updated_at) VALUES(?,?,?,?,?,'completed',?,?,?,?,?)",
        )
        .run(
          rid,
          fixture.owner,
          agent.id,
          cid,
          "Typing report " + i,
          rid,
          JSON.stringify({
            connectionId: agent.connection_id,
            model: agent.model,
          }),
          content,
          time,
          time,
        );
      fixture.db
        .prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,'assistant',?,?)",
        )
        .run(randomUUID(), fixture.owner, cid, rid, content, time);
    }
    for (let i = 0; i < 20; i++) {
      lastMessage = randomUUID();
      fixture.db
        .prepare(
          "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?)",
        )
        .run(
          lastMessage,
          fixture.owner,
          conversation,
          content,
          Date.now() + i + 100,
        );
    }
  })();
  await page.goto(fixture.base, { waitUntil: "networkidle" });
  await expect(page.locator(".inbox-results .inbox-card")).toHaveCount(40);
  await page
    .getByRole("button", { name: "Compose a message", exact: true })
    .click();
  const cdp =
    engine === "chromium" ? await page.context().newCDPSession(page) : null;
  // Make the same production bundle work under a slower CPU, rather than
  // measuring only an almost-empty Feed on a fast development machine.
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    for (const mode of ["feed", "conversation"]) {
      if (mode === "conversation") {
        await page.goto(fixture.base + "/?conversation=" + conversation, {
          waitUntil: "networkidle",
        });
        await expect(
          page.locator("dialog.conversation-sheet[open] #composer"),
        ).toBeEnabled();
      }
      const input = page.locator("#composer:visible");
      await input.focus();
      await page.evaluate(() => {
        window.__loopTypingLatencies = [];
        window.__loopMeasureTyping = () => {
          const start = performance.now();
          requestAnimationFrame(() =>
            window.__loopTypingLatencies.push(performance.now() - start),
          );
        };
        document
          .querySelector("#composer")
          .addEventListener("input", window.__loopMeasureTyping, {
            capture: true,
          });
      });
      const text = "Typing should keep up.";
      await input.pressSequentially(text, { delay: 20 });
      await expect(input).toHaveValue(text);
      await expect
        .poll(() => page.evaluate(() => window.__loopTypingLatencies.length))
        .toBe(text.length);
      const timing = await page.evaluate(() => {
        document
          .querySelector("#composer")
          .removeEventListener("input", window.__loopMeasureTyping, {
            capture: true,
          });
        const times = window.__loopTypingLatencies
          .slice()
          .sort((a, b) => a - b);
        delete window.__loopMeasureTyping;
        delete window.__loopTypingLatencies;
        return {
          median: times[Math.floor(times.length / 2)],
          p95: times[Math.floor(times.length * 0.95)],
        };
      });
      console.log(
        `${engine} ${mode} typing input-to-frame: ${JSON.stringify(timing)} ms`,
      );
      expect(
        timing.p95,
        "Typing must not wait for every unchanged answer to render",
      ).toBeLessThan(150);

      // Reusing unchanged text must still display real agent updates, without
      // replacing the draft. This also exercises compact and full Markdown.
      const update = `Updated while typing in the ${mode}.`;
      fixture.db
        .prepare("UPDATE messages SET content=? WHERE id=?")
        .run(update + "\n\n" + content, lastMessage);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("loop-source-refresh"));
        window.dispatchEvent(new Event("loop-workspace-change"));
      });
      const scope =
        mode === "feed"
          ? page.getByRole("region", { name: "Feed", exact: true })
          : page.locator("dialog.conversation-sheet[open]");
      await expect(
        scope.getByText(update, { exact: true }).first(),
      ).toBeVisible();
      await expect(input).toHaveValue(text);
      await capture("typing-" + mode);
    }
  } finally {
    await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp?.detach();
  }
}
