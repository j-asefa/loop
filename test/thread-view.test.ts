import { describe, expect, it } from "vitest";
import {
  changePrompts,
  compactNumber,
  dayLabel,
  duration,
  feedNextAction,
  feedReplyQuote,
  laterChoices,
  mergeActivityRecords,
  reminderReason,
  preview,
  relativeTime,
  runStatus,
  runTiming,
  startsNewDay,
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
    expect(dayLabel(now + DAY, now)).toBe("Tomorrow");
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

describe("merging recorded and live activity", () => {
  const source = { transport: "acp", harness: "codex", origin: "acp" };
  const record = (id: string, files: string[], state = "applied") =>
    ({
      kind: "file_change",
      id,
      source,
      data: {
        state,
        files: files.map((path) => ({ path, operation: "modify", patch: "+1", content: "available" })),
      },
    }) as unknown as ActivityRecord;
  const inRun = (run: string | null, item: ActivityRecord) => ({ run, record: item });
  it("counts an edit once whether it is recorded, live or both", () => {
    // The same record saved on two messages and also streaming live.
    const recorded = [
      inRun("r1", record("e1", ["a.ts"], "proposed")),
      inRun("r1", record("e1", ["a.ts"])),
      inRun("r1", record("e2", ["b.ts"])),
    ];
    const live = [inRun("r1", record("e2", ["b.ts"])), inRun("r1", record("e3", ["c.ts"], "failed"))];
    const merged = mergeActivityRecords(recorded, live);
    expect(merged.map(({ record }) => record.id)).toEqual(["e1", "e2", "e3"]);
    // The latest copy wins: e1 was applied after being proposed.
    expect((merged[0].record.data as any).state).toBe("applied");
  });
  it("keeps edits from different runs that reuse an activity id", () => {
    // Turn-scoped ids such as item_1:0 restart in every run.
    const merged = mergeActivityRecords(
      [inRun("r1", record("item_1:0", ["first.ts"])), inRun("r2", record("item_1:0", ["second.ts"]))],
      [],
    );
    expect(merged.map(({ run }) => run)).toEqual(["r1", "r2"]);
    expect(merged.flatMap(({ record }) => (record.data as any).files.map((file: any) => file.path)))
      .toEqual(["first.ts", "second.ts"]);
  });
  it("keeps records with the same id from different producers apart", () => {
    const other = {
      ...record("e1", ["z.ts"]),
      source: { transport: "acp", harness: "claude", origin: "other" },
    } as ActivityRecord;
    expect(mergeActivityRecords([inRun("r1", record("e1", ["a.ts"]))], [inRun("r1", other)])).toHaveLength(2);
  });
  it("treats session activity as one record across runs", () => {
    const settings = (run: string) =>
      inRun(run, { kind: "settings", id: "s", source, data: {} } as unknown as ActivityRecord);
    expect(mergeActivityRecords([settings("r1")], [settings("r2")])).toHaveLength(1);
  });
});

describe("feed next actions", () => {
  it("prefers a pending decision, then a draft, then a result", () => {
    const result = { kind: "result" as const, message_id: "m1" };
    const approve = { kind: "approve" as const, message_id: "m2" };
    expect(feedNextAction(approve, "half written")).toEqual({
      kind: "approve",
      label: "Approve request",
      message_id: "m2",
    });
    expect(feedNextAction({ kind: "answer", message_id: null }, "")?.label).toBe(
      "Answer question",
    );
    expect(feedNextAction(result, "  ")).toEqual({
      kind: "result",
      label: "Review result",
      message_id: "m1",
    });
    expect(feedNextAction(result, "half written")?.label).toBe("Continue draft");
    expect(feedNextAction(null, "")).toBeNull();
    // Never claims a decision was made.
    expect(JSON.stringify(feedNextAction(approve, ""))).not.toMatch(/approved/i);
  });
});

describe("feed reply quotes", () => {
  const done = {
    done_card_key: "run:r1",
    agent_id: "a1",
    origin: "app",
    last_message: { id: "m1", role: "assistant", content: "The **result**", preview: "The result" },
  };
  it("quotes the result a Done card shows", () => {
    expect(feedReplyQuote(done)).toEqual({
      agentId: "a1",
      messageId: "m1",
      content: "The **result**",
    });
    expect(
      feedReplyQuote({ ...done, last_message: { ...done.last_message, role: "user" } }),
    ).toMatchObject({ messageId: "m1", mine: true });
  });
  it("quotes an independently published reply when continuing its conversation", () => {
    expect(feedReplyQuote({ ...done, done_card_key: undefined, reply_card_key: "reply:m1" })).toEqual({
      agentId: "a1", messageId: "m1", content: "The **result**",
    });
  });
  it("replies to the thread unquoted when there is nothing to quote", () => {
    expect(feedReplyQuote({ ...done, done_card_key: undefined })).toBeNull();
    expect(feedReplyQuote({ ...done, agent_id: null })).toBeNull();
    expect(feedReplyQuote({ ...done, origin: "chatgpt-import" })).toBeNull();
    expect(feedReplyQuote({ ...done, last_message: null })).toBeNull();
    expect(
      feedReplyQuote({ ...done, last_message: { ...done.last_message, content: "  " } }),
    ).toBeNull();
  });
});

describe("reminder reasons", () => {
  const base = { due_at: null, surfaced_at: null, project_name: "Site" };
  it("says why a reminder is or will be back", () => {
    expect(reminderReason({ ...base, condition: "run_finished" }, now)).toBe(
      "When the agent finishes",
    );
    expect(
      reminderReason({ ...base, condition: "run_finished", surfaced_at: now }, now),
    ).toBe("The agent finished");
    expect(
      reminderReason({ ...base, condition: "project_open", surfaced_at: now }, now),
    ).toBe("You opened Site");
    const nine = new Date(2026, 8, 30, 9, 0).getTime();
    expect(
      reminderReason({ ...base, condition: "time", due_at: nine, surfaced_at: now }, now),
    ).toMatch(/^Due today at /);
    expect(
      reminderReason({ ...base, condition: "time", due_at: nine + DAY }, now),
    ).toMatch(/^Tomorrow at /);
  });
});

describe("change follow-up prompts", () => {
  it("ask for verification of the full diff and name the run and project", () => {
    // Started today: a fixed date reads as a weekday or a date once it is
    // more than a day old, so the phrase is checked against the clock.
    const today = new Date();
    today.setHours(10, 42, 0, 0);
    const start = today.getTime();
    const prompts = changePrompts(["src/a.ts", "src/b.ts"], {
      projectName: "Site",
      runStartedAt: [start],
    });
    for (const prompt of Object.values(prompts)) {
      expect(prompt).toContain("git diff");
      expect(prompt).toContain("saved Git snapshot");
      expect(prompt).not.toContain("tools reported");
      expect(prompt).toContain("in the Site project");
      expect(prompt).toContain("- src/a.ts\n- src/b.ts");
    }
    expect(prompts.commit).toMatch(/from the run that started today at /);
    expect(prompts.revert).toContain("keeping any other changes");
    expect(prompts.pr).toContain("pull request link");
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
