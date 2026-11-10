import { describe, expect, it } from "vitest";
import { Codex } from "../src/adapters/codex";
import {
  codexActivities,
  directUpdates,
  piActivities,
  openCodeActivities,
  claudeActivities,
} from "../src/adapters/direct-activities";

describe("authoritative direct activity extraction", () => {
  it("replaces structured plans without deriving steps from assistant prose", () => {
    expect(
      codexActivities("item/completed", {
        item: { id: "a", type: "agentMessage", text: "Plan: write code" },
      }),
    ).toEqual([]);
    const p = codexActivities("turn/plan/updated", {
      turnId: "t",
      plan: [{ step: "<img onerror=alert(1)>", status: "inProgress" }],
    })[0];
    expect(p).toMatchObject({
      kind: "plan",
      id: "plan:t",
      steps: [
        { id: "0", status: "in_progress", text: "<img onerror=alert(1)>" },
      ],
    });
    expect(
      codexActivities("turn/plan/updated", { turnId: "t", plan: [] })[0],
    ).toMatchObject({ id: "plan:t", steps: [] });
  });
  it("keeps proposed/failed/declined/executed edits distinct and preserves rename paths", () => {
    for (const [status, expected] of [
      ["inProgress", "proposed"],
      ["failed", "failed"],
      ["declined", "declined"],
      ["completed", "executed"],
    ]) {
      expect(
        codexActivities("item/completed", {
          item: {
            id: "f",
            type: "fileChange",
            status,
            changes: [
              {
                path: "old",
                kind: { type: "update", move_path: "new" },
                diff: "-old\n+new",
              },
            ],
          },
        })[0],
      ).toMatchObject({ path: "new", oldPath: "old", state: expected });
    }
  });
  it("bounds output while retaining an authoritative zero exit code", () => {
    const result = codexActivities("item/completed", {
      item: {
        id: "cmd",
        type: "commandExecution",
        aggregatedOutput: "x".repeat(100000) + "tail",
        exitCode: 0,
        status: "completed",
      },
    })[0];
    expect(result).toMatchObject({
      kind: "output",
      exitCode: 0,
      truncated: true,
      stream: "combined",
    });
    if (result.kind === "output") expect(result.text).toHaveLength(48000);
  });
  it("Pi partial output is a replacement snapshot, and prose never supplies exit codes", () => {
    const input = { toolName: "bash", args: { command: "check" } };
    const first = piActivities(
      {
        type: "tool_execution_update",
        toolCallId: "c",
        partialResult: {
          content: [{ type: "text", text: "Command exited with code 7" }],
        },
      },
      input,
    )[0];
    expect(first).toMatchObject({
      kind: "output",
      state: "running",
      text: "Command exited with code 7",
    });
    expect(first).not.toHaveProperty("exitCode");
    expect(
      piActivities(
        {
          type: "tool_execution_end",
          toolCallId: "c",
          result: {
            content: [{ type: "text", text: "final" }],
            details: { truncation: { truncated: true } },
          },
        },
        input,
      )[0],
    ).toMatchObject({ text: "final", truncated: true });
  });
  it("requires an actual Pi edit diff and ignores unstructured success claims", () => {
    const event = {
      type: "tool_execution_end",
      toolCallId: "e",
      toolName: "edit",
      args: { path: "../../hostile" },
      result: { content: [{ type: "text", text: "Changed everything" }] },
    };
    expect(piActivities(event)).toEqual([]);
    expect(
      piActivities({ ...event, result: { details: { patch: "-a\n+b" } } })[0],
    ).toMatchObject({ kind: "file", path: "../../hostile", state: "executed" });
  });
  it("maps OpenCode structured metadata but never guesses edits from a tool title", () => {
    expect(
      openCodeActivities("message.part.updated", {
        part: {
          id: "e",
          type: "tool",
          tool: "edit",
          state: { status: "completed", output: "diff --git fake" },
        },
      }),
    ).toEqual([]);
    expect(
      openCodeActivities("message.part.updated", {
        part: {
          id: "e",
          type: "tool",
          state: {
            status: "running",
            metadata: { filediff: { file: "a", patch: "-x\n+y" } },
          },
        },
      })[0],
    ).toMatchObject({ kind: "file", state: "unknown" });
  });
  it("does not treat arbitrary Claude tool results as command output", () => {
    const block = {
      type: "tool_result",
      tool_use_id: "b",
      content: "shell output",
    };
    expect(claudeActivities(block)).toEqual([]);
    expect(claudeActivities(block, { name: "MCP", input: {} })).toEqual([]);
    expect(
      claudeActivities(block, {
        name: "Bash",
        input: { command: "echo test" },
      })[0],
    ).toMatchObject({
      kind: "output",
      command: "echo test",
      text: "shell output",
    });
  });
});

it("sends Codex effort using the documented turn/start field", async () => {
  const adapter = new Codex(
    {
      harness: "codex",
      executable: "unused",
      project: "/fixture",
      billing: "existing",
      version: "fixture",
      effort: "medium",
    },
    () => {},
  );
  const calls: { method: string; params: any }[] = [];
  (adapter as any).native = {
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      return { turn: { id: "t", status: "inProgress" } };
    },
  };
  await adapter.prompt("test");
  expect(calls[0]).toMatchObject({
    method: "turn/start",
    params: { effort: "medium" },
  });
  expect(calls[0].params).not.toHaveProperty("reasoningEffort");
});

it("keeps native tool IDs ending in digits while separating Codex file records", () => {
  const id = "native-tool:7";
  const codex = directUpdates(
    "codex",
    codexActivities("item/completed", {
      item: {
        id,
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "one.ts", diff: "+one" },
          { path: "two.ts", diff: "+two" },
        ],
      },
    }),
  );
  expect(codex).toHaveLength(2);
  expect(codex.map((update) => update.id)).toEqual([id + ":0", id + ":1"]);
  for (const update of codex)
    expect(update.patch).toMatchObject({ tool: id, state: "applied" });
  const cases = [
    [
      "pi",
      piActivities({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "write",
        args: { path: "one.ts", content: "one" },
        result: {},
      }),
    ],
    [
      "claude",
      claudeActivities(
        { type: "tool_result", tool_use_id: id },
        { name: "Write", input: { file_path: "one.ts", content: "one" } },
      ),
    ],
    [
      "opencode",
      openCodeActivities("message.part.updated", {
        part: {
          id: "part",
          callID: id,
          type: "tool",
          state: {
            status: "completed",
            metadata: { filediff: { file: "one.ts", patch: "+one" } },
          },
        },
      }),
    ],
  ] as const;
  for (const [harness, values] of cases) {
    const updates = directUpdates(harness, values);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id,
      kind: "file_change",
      patch: { tool: id, state: "applied" },
    });
  }
});
