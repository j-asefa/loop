import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Claude } from "../src/adapters/claude";
import type { Native } from "../src/native";

async function observed(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Control fixture did not respond");
    await delay(10);
  }
}

it.each(["timeout", "dispose"] as const)(
  "Claude preserves an uncertain setting after %s and never replays it",
  async (ending) => {
    const directory = mkdtempSync(join(tmpdir(), "loop-claude-control-"));
    const audit = join(directory, "requests");
    vi.stubEnv("LOOP_TEST_HARNESS", "claude");
    vi.stubEnv("LOOP_TEST_SETTING_AUDIT", audit);
    vi.stubEnv("LOOP_TEST_SETTING_HOLD", "1");
    const adapter = new Claude(
      {
        harness: "claude",
        executable: resolve("test/harness.mjs"),
        project: directory,
        billing: "existing",
        permissionMode: "default",
        version: "fixture",
      },
      () => {},
    );
    try {
      await adapter.start();
      const native = Reflect.get(adapter, "native") as Native;
      let wrongEnvelope = false;
      native.on("message", (message) => {
        if (message.id && message.result) wrongEnvelope = true;
      });
      if (ending === "timeout")
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const outcome = adapter
        .setSetting("mode", "plan", adapter.settings.revision)
        .then(
          () => undefined,
          (error: Error) => error,
        );
      await observed(() => wrongEnvelope);
      expect(
        adapter.settings.options.find((o) => o.id === "mode"),
      ).toMatchObject({
        confirmed: "default",
        requested: "plan",
      });
      if (ending === "timeout") await vi.advanceTimersByTimeAsync(30000);
      else await adapter.dispose();
      expect((await outcome)?.message).toBe(
        ending === "timeout"
          ? "Claude control timed out; outcome unknown."
          : "Stopped",
      );
      vi.useRealTimers();
      expect(
        adapter.settings.options.find((o) => o.id === "mode")?.confirmed,
      ).toBe("default");
      expect(readFileSync(audit, "utf8")).toBe("plan\n");
      if (ending === "timeout") {
        // The fixture sends the expired plan response before this new response.
        await adapter.setSetting("mode", "default", adapter.settings.revision);
        expect(
          adapter.settings.options.find((o) => o.id === "mode")?.confirmed,
        ).toBe("default");
        expect(readFileSync(audit, "utf8")).toBe("plan\ndefault\n");
      }
    } finally {
      vi.useRealTimers();
      await adapter.dispose();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
