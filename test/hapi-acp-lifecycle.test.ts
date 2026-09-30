import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedAcpPrompt } from "../native/loopManaged";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loop-acp-"));
  dirs.push(dir);
  const file = join(dir, "launch.json");
  writeFileSync(file, JSON.stringify({ generation: 3 }));
  vi.stubEnv("LOOP_MANAGED", "1");
  vi.stubEnv("LOOP_LAUNCH_FILE", file);
  vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "3");
  const events: any[] = [];
  const update = vi.fn();
  const run = (
    prompt: (update: (message: any) => void) => Promise<void>,
    preflight?: () => Promise<void>,
  ) =>
    managedAcpPrompt({
      threadId: "native-session",
      items: [{ localId: "dispatch-a" }, { localId: "dispatch-b" }],
      send: (event, key) => events.push({ ...event, key }),
      prompt,
      preflight,
      update,
    });
  return { events, update, run };
}
it("binds completion and reconstructed text to each accepted dispatch", async () => {
  const f = fixture();
  await f.run(async (update) => {
    update({ type: "text", id: "answer", text: "hel", live: true });
    update({ type: "text", id: "answer", text: "lo", live: true });
    update({
      type: "text",
      id: "answer",
      text: "hello!",
      streamSnapshot: true,
    });
    update({ type: "turn_complete", stopReason: "end_turn" });
  });
  expect(f.events.map((e) => [e.localId, e.status])).toEqual([
    ["dispatch-a", "running"],
    ["dispatch-b", "running"],
    ["dispatch-a", "completed"],
    ["dispatch-b", "completed"],
  ]);
  expect(f.events[2]).toMatchObject({
    threadId: "native-session",
    output: "hello!",
  });
  expect(new Set(f.events.map((e) => e.key)).size).toBe(4);
  expect(f.update).toHaveBeenCalledTimes(4);
});
it.each(["cancelled", "max_tokens", "refusal"])(
  "projects native stop reason %s honestly",
  async (reason) => {
    const f = fixture();
    await f.run(async (update) =>
      update({ type: "turn_complete", stopReason: reason }),
    );
    expect(f.events.at(-1).status).toBe(
      reason === "cancelled" ? "cancelled" : "failed",
    );
  },
);
it("does not turn native error into success", async () => {
  const f = fixture();
  await f.run(async (update) => {
    update({ type: "error", message: "fixture failure" });
    update({ type: "turn_complete", stopReason: "end_turn" });
  });
  expect(f.events.at(-1).status).toBe("failed");
});
it.each([false, true])(
  "leaves missing or rejected completion uncertain without replay (%s)",
  async (rejects) => {
    const f = fixture();
    const prompt = vi.fn(async () => {
      if (rejects) throw new Error("raw sensitive error");
    });
    await expect(f.run(prompt)).rejects.toThrow("delivery is uncertain");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(f.events.slice(2).map((e) => e.type)).toEqual([
      "loop-delivery-unknown",
      "loop-delivery-unknown",
    ]);
    expect(JSON.stringify(f.events)).not.toContain("sensitive");
  },
);
it("rechecks the generation before dispatching queued work", async () => {
  const f = fixture();
  vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "4");
  const prompt = vi.fn(async () => {});
  await expect(f.run(prompt)).rejects.toThrow("Fenced environment");
  expect(prompt).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});
it("leaves standalone HAPI prompt behavior unchanged", async () => {
  const f = fixture();
  vi.stubEnv("LOOP_MANAGED", "0");
  await f.run(async (update) => update({ type: "text", text: "standalone" }));
  expect(f.events).toEqual([]);
  expect(f.update).toHaveBeenCalledWith({ type: "text", text: "standalone" });
});

it("settles every rejected dispatch without calling the native prompt or leaking policy data", async () => {
  const f = fixture();
  const prompt = vi.fn(async () => {});
  await expect(
    f.run(prompt, async () => {
      throw new Error("secret policy value");
    }),
  ).rejects.toThrow("preflight rejected");
  expect(prompt).not.toHaveBeenCalled();
  expect(f.events.map((e) => [e.localId, e.status])).toEqual([
    ["dispatch-a", "running"],
    ["dispatch-b", "running"],
    ["dispatch-a", "failed"],
    ["dispatch-b", "failed"],
  ]);
  expect(JSON.stringify(f.events)).not.toContain("secret");
  expect(f.events.some((e) => e.type === "loop-delivery-unknown")).toBe(false);
});
it("refuses a generation change while the asynchronous policy probe is running", async () => {
  const f = fixture();
  const prompt = vi.fn(async () => {});
  await expect(
    f.run(prompt, async () => {
      vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "4");
    }),
  ).rejects.toThrow("preflight rejected");
  expect(prompt).not.toHaveBeenCalled();
  expect(f.events.slice(2).map((e) => e.status)).toEqual(["failed", "failed"]);
});
it("keeps post-preflight delivery failures uncertain", async () => {
  const f = fixture();
  const preflight = vi.fn(async () => {});
  const prompt = vi.fn(async () => {
    throw new Error("lost transport");
  });
  await expect(f.run(prompt, preflight)).rejects.toThrow(
    "delivery is uncertain",
  );
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(f.events.slice(2).map((e) => e.type)).toEqual([
    "loop-delivery-unknown",
    "loop-delivery-unknown",
  ]);
});
