import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("logs maintenance failures safely, preserves delivery order and waits for feed refresh", async () => {
  vi.resetModules();
  const directory = mkdtempSync(join(tmpdir(), "loop-maintenance-"));
  vi.stubEnv("LOOP_DATA_DIR", directory);
  const { db, changes } = await import("../src/server/db");
  const mobile = await import("../src/server/mobile-return");
  const mail = await import("../src/server/agent-mail");
  const notifications = await import("../src/server/notifications");
  const webhooks = await import("../src/server/webhooks");
  const news = await import("../src/server/news");
  const digests = await import("../src/server/feed-digests");
  const watches = await import("../src/server/feed-watches");
  const prs = await import("../src/server/pr-watches");
  const memory = await import("../src/server/memory");
  const search = await import("../src/server/search");
  const order: string[] = [];
  const fault = Object.assign(new Error("private provider token"), {
    code: "E_FIXTURE",
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(mobile, "surfaceLater").mockImplementation(() => {
    order.push("later");
    throw fault;
  });
  vi.spyOn(mobile, "deliverScheduledSends").mockImplementation(() => {
    order.push("scheduled");
    return 0;
  });
  vi.spyOn(mail, "sweepAgentMail").mockImplementation(() => {
    order.push("mail");
  });
  vi.spyOn(notifications, "deliverNotifications").mockImplementation(
    async () => {
      order.push("notifications");
      throw fault;
    },
  );
  let signal: AbortSignal | undefined;
  vi.spyOn(webhooks, "deliverWebhooks").mockImplementation(async (input) => {
    signal = input;
    order.push("webhooks");
  });
  const refresh = vi
    .spyOn(news, "refreshDueFeeds")
    .mockRejectedValueOnce(fault)
    .mockResolvedValue(0);
  const digest = vi.spyOn(digests, "runDueDigests").mockImplementation(() => {
    order.push("digest");
    throw fault;
  });
  const match = vi.spyOn(watches, "matchWatches").mockImplementation(() => {
    order.push("watch");
    return 0;
  });
  vi.spyOn(prs, "pollWatches").mockResolvedValue(0);
  vi.spyOn(memory, "captureMemory").mockImplementation(() => {});
  vi.spyOn(search, "indexPending").mockResolvedValue(undefined);
  const { startMaintenance } = await import("../src/server/worker-maintenance");
  const jobs: Promise<unknown>[] = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const subscribers = changes.subscriberCount;
  const stop = startMaintenance(
    (job) => jobs.push(job),
    () => {},
  );
  try {
    await vi.advanceTimersByTimeAsync(3000);
    expect(order.slice(0, 5)).toEqual([
      "later",
      "scheduled",
      "mail",
      "notifications",
      "webhooks",
    ]);
    await vi.advanceTimersByTimeAsync(57000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(digest).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(digest).toHaveBeenCalledOnce();
    expect(match).toHaveBeenCalledOnce();
    expect(
      order.filter((task) => task === "digest" || task === "watch"),
    ).toEqual(["digest", "watch"]);
    const reports = warn.mock.calls.map(([line]) => JSON.parse(line));
    for (const task of [
      "later.surface",
      "notifications.deliver",
      "feeds.refresh",
      "digests.run",
    ])
      expect(reports).toContainEqual({
        diagnostic: "background-task-failed",
        task,
        type: "Error",
        code: "E_FIXTURE",
        causes: ["E_FIXTURE"],
      });
    expect(JSON.stringify(reports)).not.toContain("private provider token");
    stop();
    expect(signal?.aborted).toBe(true);
    expect(changes.subscriberCount).toBe(subscribers);
    const calls = order.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(order).toHaveLength(calls);
  } finally {
    stop();
    await Promise.allSettled(jobs);
    vi.useRealTimers();
    changes.close();
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
