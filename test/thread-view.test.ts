import { describe, expect, it } from "vitest";
import {
  compactNumber,
  dayLabel,
  duration,
  laterChoices,
  preview,
  relativeTime,
  runStatus,
  runTiming,
  startsNewDay,
  summarizeChanges,
} from "../src/client/threadView";
import type { ActivityRecord } from "../src/agent-activities";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A fixed local Wednesday afternoon keeps day and time labels deterministic.
const now = new Date(2026, 8, 30, 15, 30).getTime();

describe("relative time and durations", () => {
  it("uses short, row-sized labels", () => {
    expect(relativeTime(now - 20_000, now)).toBe("Just now");
    expect(relativeTime(now - 5 * MINUTE, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * HOUR, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * DAY, now)).toBe("2d ago");
    expect(relativeTime(now + MINUTE, now)).toBe("Just now");
    expect(duration(45_000)).toBe("45s");
    expect(duration(2 * HOUR + 5 * MINUTE)).toBe("2h 5m");
  });
  it("labels days and detects day boundaries", () => {
    expect(dayLabel(now - HOUR, now)).toBe("Today");
    expect(dayLabel(now - DAY, now)).toBe("Yesterday");
    expect(dayLabel(now - 3 * DAY, now)).not.toMatch(/Today|Yesterday/);
    expect(startsNewDay(now)).toBe(true);
    expect(startsNewDay(now, now - HOUR)).toBe(false);
    expect(startsNewDay(now, now - DAY)).toBe(true);
  });
  it("describes queued and running work", () => {
    expect(
      runTiming(
        { created_at: now - 2 * HOUR, updated_at: now - 3 * MINUTE, state: "running" },
        now,
      ),
    ).toBe("Started 2h ago · last update 3m ago");
    expect(
      runTiming(
        { created_at: now - 10 * MINUTE, updated_at: now, state: "queued" },
        now,
      ),
    ).toBe("Queued 10m ago");
  });
});

describe("run status vocabulary", () => {
  it("puts pending approvals ahead of the run state", () => {
    expect(runStatus("running", 1)).toEqual({ label: "Needs approval", tone: "needs" });
    expect(runStatus("waiting_children").tone).toBe("working");
    expect(runStatus("interrupted").tone).toBe("failed");
    expect(runStatus(null)).toEqual({ label: "", tone: "idle" });
  });
});

describe("previews", () => {
  it("drops markdown syntax but keeps words and hyphens", () => {
    expect(
      preview("## Review complete\n\n- **Keep** the `route`\n> e-mail [link](https://x.test)"),
    ).toBe("Review complete Keep the route e-mail link");
    expect(preview("a".repeat(200), 20)).toHaveLength(20);
    expect(preview("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe("a b 1 2");
  });
  it("compacts token counts", () => {
    expect(compactNumber(950)).toBe("950");
    expect(compactNumber(1234)).toBe("1.2k");
    expect(compactNumber(12_300)).toBe("12k");
    expect(compactNumber(2_400_000)).toBe("2.4M");
  });
});

const change = (
  id: string,
  files: { path: string; operation: string; patch?: string; after?: string }[],
  state = "applied",
) =>
  ({
    kind: "file_change",
    id,
    data: { state, files: files.map((f) => ({ content: "available", ...f })) },
  }) as unknown as ActivityRecord;

describe("change summaries", () => {
  it("keeps every edit per path and counts only applied ones", () => {
    const summary = summarizeChanges([
      change("1", [
        { path: "src/a.ts", operation: "modify", patch: "--- a\n+++ b\n+one\n-two" },
      ]),
      { kind: "plan", id: "p", data: { steps: [] } } as unknown as ActivityRecord,
      change("2", [
        { path: "src/a.ts", operation: "modify", patch: "+one\n+two\n-three" },
        { path: "src/new.ts", operation: "create", after: "x\ny\n" },
      ]),
      // A later failed edit neither replaces the applied history nor counts.
      change("3", [{ path: "src/a.ts", operation: "modify", patch: "+bad" }], "failed"),
      change("4", [{ path: "src/idea.ts", operation: "create", after: "z\n" }], "proposed"),
      change("5", [{ path: "src/broken.ts", operation: "modify", patch: "+x" }], "failed"),
    ]);
    const a = summary.files.find((f) => f.path === "src/a.ts")!;
    expect(a.edits.map((e) => [e.state, e.additions, e.deletions])).toEqual([
      ["applied", 1, 1],
      ["applied", 2, 1],
      ["failed", 1, 0],
    ]);
    expect(a).toMatchObject({ state: "applied", additions: 3, deletions: 2 });
    expect(summary.files.find((f) => f.path === "src/new.ts")).toMatchObject({
      state: "applied",
      additions: 2,
    });
    expect(summary.files.find((f) => f.path === "src/idea.ts")).toMatchObject({
      state: "proposed",
      additions: 0,
    });
    expect(summary).toMatchObject({
      additions: 5,
      deletions: 2,
      applied: 2,
      proposed: 1,
      failed: 1,
    });
  });
  it("returns an empty summary without file changes", () => {
    expect(summarizeChanges([])).toEqual({
      files: [],
      additions: 0,
      deletions: 0,
      applied: 0,
      proposed: 0,
      failed: 0,
    });
  });
});

describe("later choices", () => {
  it("offers future times and conditional choices only when they apply", () => {
    const choices = laterChoices(now);
    expect(choices.every((c) => c.condition !== "time" || c.dueAt! > now)).toBe(true);
    expect(choices.map((c) => c.id)).toEqual(["hour", "tonight", "tomorrow", "monday"]);
    const tomorrow = choices.find((c) => c.id === "tomorrow")!;
    expect(new Date(tomorrow.dueAt!).getHours()).toBe(9);
    const withContext = laterChoices(now, {
      running: true,
      project: { id: "p", name: "Loop" },
    });
    expect(withContext.at(-2)).toMatchObject({ condition: "run_finished" });
    expect(withContext.at(-1)).toMatchObject({
      condition: "project_open",
      label: "Next time I open Loop",
    });
  });
  it("skips this evening once it is too close", () => {
    const late = new Date(2026, 8, 30, 18, 30).getTime();
    expect(laterChoices(late).some((c) => c.id === "tonight")).toBe(false);
  });
});
