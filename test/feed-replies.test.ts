import { expect, it, vi } from "vitest";
import { readReplyFeedPage } from "../src/client/feed-replies";

const legacy = { items: ["ordinary output"], next: "old cursor", summary: {} };
const current = { items: ["published reply"], next: null, summary: { replies_unread: 1 } };
const failure = (status: number) => Object.assign(new Error("Feed refused"), { status });

it("recognizes an older source without classifying its ordinary output and rechecks after upgrade", async () => {
  const read = vi.fn().mockRejectedValue(failure(400));
  const probe = vi.fn().mockResolvedValue(legacy);
  expect(await readReplyFeedPage(read, probe)).toEqual({ page: { ...legacy, items: [], next: null }, supported: false });
  read.mockResolvedValue(current);
  expect(await readReplyFeedPage(read, probe)).toEqual({ page: current, supported: true });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(await readReplyFeedPage(async () => legacy, probe)).toMatchObject({ page: { items: [], next: null }, supported: false });
});

it("keeps authorization, outages, invalid cursors and supported-source refusals visible", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const probe = vi.fn().mockResolvedValue(legacy);
    await expect(readReplyFeedPage(async () => { throw failure(status); }, probe)).rejects.toMatchObject({ status });
    expect(probe).not.toHaveBeenCalled();
  }
  for (const status of [400, 404]) {
    const read = async () => { throw failure(status); };
    const probe = vi.fn().mockResolvedValue(legacy);
    await expect(readReplyFeedPage(read, probe, "invalid cursor")).rejects.toMatchObject({ status });
    expect(probe).not.toHaveBeenCalled();
    await expect(readReplyFeedPage(read, async () => current)).rejects.toMatchObject({ status });
    await expect(readReplyFeedPage(read, async () => { throw failure(503); })).rejects.toMatchObject({ status: 503 });
  }
});
