import { describe, expect, it } from "vitest";
import { activityLine } from "../src/client/activityLine";

const base = {
  v: 1 as const,
  id: "a",
  source: { transport: "native" as const, origin: "test" },
  revision: 1,
  fieldSeq: {},
  partial: false,
  replayed: false,
};
const tool = (data: Record<string, unknown>) => ({
  ...base,
  kind: "tool" as const,
  data: { status: "running", content: [], links: {}, ...data },
});
const item = (sequence: number, record: unknown, run: string | null = "r1") =>
  ({ run, sequence, record }) as Parameters<typeof activityLine>[0][number];

describe("activityLine", () => {
  it("uses the latest step of the run, in the harness's words", () => {
    const items = [
      item(1, tool({ title: "Read Feed.tsx", status: "completed" })),
      item(2, tool({ title: "Run npm test", status: "running" })),
      item(3, tool({ title: "Other run" }), "r2"),
    ];
    expect(activityLine(items, "r1")).toEqual({
      text: "Run npm test",
      state: "live",
    });
  });

  it("falls back to the tool's category and first path, never invented text", () => {
    expect(
      activityLine(
        [
          item(
            1,
            tool({
              category: "read",
              locations: ["/repo/src/client/Feed.tsx"],
              status: "completed",
            }),
          ),
        ],
        "r1",
      ),
    ).toEqual({ text: "read Feed.tsx", state: "done" });
    expect(activityLine([item(1, tool({}))], "r1")).toBeNull();
  });

  it("shows commands, edited files and the plan step in progress", () => {
    const output = {
      ...base,
      kind: "output" as const,
      data: { command: "npm test", status: "running", chunks: [] },
    };
    expect(activityLine([item(1, output)], "r1")).toEqual({
      text: "npm test",
      state: "live",
    });
    const edit = {
      ...base,
      kind: "file_change" as const,
      data: { state: "applied", files: [{ path: "src/a/b.ts" }] },
    };
    expect(activityLine([item(1, edit)], "r1")).toEqual({
      text: "b.ts",
      state: "done",
    });
    const plan = {
      ...base,
      kind: "plan" as const,
      data: {
        revision: 1,
        steps: [
          { id: "1", title: "Read the thread", status: "completed" },
          { id: "2", title: "Build the page", status: "in_progress" },
        ],
      },
    };
    expect(activityLine([item(1, plan)], "r1")).toEqual({
      text: "Build the page",
      state: "live",
    });
  });

  it("has no line for a run without activity, and skips capabilities", () => {
    expect(activityLine([], "r1")).toBeNull();
    expect(activityLine([item(5, { kind: "capabilities" })], "r1")).toBeNull();
  });

  it("never shows a failed, cancelled or uncertain step as done", () => {
    const states = (status: string) =>
      activityLine([item(1, tool({ title: "Run npm test", status }))], "r1")
        ?.state;
    expect(states("failed")).toBe("failed");
    expect(states("cancelled")).toBe("failed");
    expect(states("unknown")).toBe("unknown");
    const output = (data: Record<string, unknown>) =>
      activityLine(
        [
          item(1, {
            ...base,
            kind: "output",
            data: { command: "npm test", chunks: [], ...data },
          }),
        ],
        "r1",
      )?.state;
    expect(output({ status: "exited", exitCode: 0 })).toBe("done");
    expect(output({ status: "exited", exitCode: 1 })).toBe("failed");
    expect(output({ status: "exited" })).toBe("unknown");
    expect(output({ status: "failed" })).toBe("failed");
    expect(output({ status: "unknown" })).toBe("unknown");
  });

  it("skips records of another version", () => {
    expect(
      activityLine(
        [item(1, { ...tool({ title: "Later shape" }), v: 2 })],
        "r1",
      ),
    ).toBeNull();
  });
});
