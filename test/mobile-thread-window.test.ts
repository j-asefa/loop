import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  revealEarlierId,
  runFileRequests,
  THREAD_RENDER_STEP,
  threadWindowStart,
} from "../apps/mobile/src/thread-window.js";

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

describe("mobile thread render window", () => {
  it("renders only the newest step of a full page on open", () => {
    const page = ids(51);
    expect(threadWindowStart(page, null)).toBe(51 - THREAD_RENDER_STEP);
    expect(threadWindowStart(ids(5), null)).toBe(0);
  });

  it("reveals loaded messages a step at a time, then stays pinned", () => {
    const page = ids(30);
    const start = threadWindowStart(page, null, 12);
    const pinned = revealEarlierId(page, start, 12);
    expect(pinned).toBe("m6");
    expect(threadWindowStart(page, pinned, 12)).toBe(6);
    // A new reply extends the window instead of sliding m6 out.
    expect(threadWindowStart([...page, { id: "m30" }], pinned, 12)).toBe(6);
    expect(revealEarlierId(page, 6, 12)).toBe("m0");
  });

  it("falls back to the newest step when the pinned message is gone", () => {
    expect(threadWindowStart(ids(20), "deleted", 12)).toBe(8);
  });
});

describe("mobile thread published-file requests", () => {
  const msg = (id: string, run: string | null, content = "x") => ({
    id,
    role: "assistant",
    run_id: run,
    content,
    run_state: "completed",
  });

  it("asks once per run, keyed by the run's newest message", () => {
    const messages = [
      msg("a1", "r1"),
      { ...msg("u1", "r1"), role: "user" },
      msg("a2", "r1"),
      msg("b1", "r2"),
      msg("c1", null),
    ];
    const first = runFileRequests(messages, new Map());
    expect(first.map((r) => r.runId)).toEqual(["r1", "r2"]);
    const fetched = new Map(first.map((r) => [r.runId, r.signature]));
    expect(runFileRequests(messages, fetched)).toEqual([]);
    const grown = [...messages.slice(0, 3), msg("b1", "r2", "xy")];
    expect(runFileRequests(grown, fetched).map((r) => r.runId)).toEqual(["r2"]);
  });

  it("ThreadSheet renders and fetches files for the window only", () => {
    const thread = readFileSync(
      path.join(
        import.meta.dirname,
        "../apps/mobile/src/components/ThreadSheet.tsx",
      ),
      "utf8",
    );
    expect(thread).toContain("{visibleMessages.map((msg) => {");
    expect(thread).not.toContain("{messages.map((msg) => {");
    expect(thread).toContain("runFileRequests(visibleMessages, fetched)");
    expect(thread).toContain("onReplyButton={handleReplyButton}");
  });
});
