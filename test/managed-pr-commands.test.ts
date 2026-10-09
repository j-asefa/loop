import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  managedAcpPrompt,
  managedClaudeCommands,
  managedPiDelivery,
} from "../native/loopManaged";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loop-pr-commands-"));
  dirs.push(dir);
  const launch = join(dir, "launch.json");
  writeFileSync(launch, JSON.stringify({ generation: 1 }));
  vi.stubEnv("LOOP_MANAGED", "1");
  vi.stubEnv("LOOP_LAUNCH_FILE", launch);
  vi.stubEnv("LOOP_ENVIRONMENT_GENERATION", "1");
  const events: any[] = [];
  return { events, send: (event: any) => events.push(event) };
}
const command = "gh pr create --fill";
const output = "https://github.com/acme/api/pull/42\n";
const expected = { type: "loop-command", localId: "dispatch", command, output };

it("Claude correlates successful Bash results with the accepted dispatch, never a child or earlier prompt", () => {
  const f = fixture();
  const observe = managedClaudeCommands(f.send);
  const start = (id: string) => ({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });
  const end = (id: string, is_error = false) => ({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content: output, is_error },
      ],
    },
  });
  observe(start("failed"), ["dispatch"]);
  observe(end("failed", true), ["dispatch"]);
  observe({ ...start("child"), parent_tool_use_id: "parent" }, ["dispatch"]);
  observe(end("child"), ["dispatch"]);
  observe(start("old"), ["old-dispatch"]);
  observe(end("old"), ["dispatch"]);
  expect(f.events).toEqual([]);
  observe(start("created"), ["dispatch"]);
  observe(end("created"), ["dispatch"]);
  observe(end("created"), ["dispatch"]);
  expect(f.events).toEqual([{ ...expected, id: "created" }]);
});

it("Pi reports completed bash commands only during its originating native lifecycle", () => {
  const f = fixture();
  const delivery = managedPiDelivery(f.send);
  const start = (id: string) => ({
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "bash",
    args: { command },
  });
  const end = (id: string, isError?: boolean) => ({
    type: "tool_execution_end",
    toolCallId: id,
    isError,
    result: { content: [{ type: "text", text: output }] },
  });
  delivery.observe(start("terminal"));
  delivery.begin("dispatch");
  delivery.observe(end("terminal"));
  delivery.observe(start("failed"));
  delivery.observe(end("failed", true));
  delivery.observe(start("created"));
  delivery.observe(end("created"));
  delivery.observe(end("created"));
  expect(f.events).toEqual([{ ...expected, id: "created" }]);
  delivery.lost();
  delivery.observe(start("late"));
  delivery.observe(end("late"));
  expect(f.events.filter((e) => e.type === "loop-command")).toHaveLength(1);
});

it("OpenCode's ACP bridge correlates tool input and successful output to one dispatch", async () => {
  const f = fixture();
  await managedAcpPrompt({
    threadId: "native",
    items: [{ localId: "dispatch" }],
    send: f.send,
    update() {},
    prompt: async (update) => {
      update({
        type: "tool_call",
        id: "failed",
        name: "bash",
        input: { command },
      } as any);
      update({
        type: "tool_result",
        id: "failed",
        output,
        status: "failed",
      } as any);
      update({
        type: "tool_result",
        id: "unlinked",
        output,
        status: "completed",
      } as any);
      update({
        type: "tool_call",
        id: "created",
        name: "bash",
        input: { command },
      } as any);
      update({
        type: "tool_result",
        id: "created",
        output: { content: [{ type: "text", text: output }] },
        status: "completed",
      } as any);
      update({ type: "turn_complete", stopReason: "end_turn" });
    },
  });
  expect(f.events.filter((e) => e.type === "loop-command")).toEqual([
    { ...expected, id: "created" },
  ]);
});

it("Pi rejects its native nested truncation flag even when the retained tail contains a PR URL", () => {
  const f = fixture();
  const delivery = managedPiDelivery(f.send);
  delivery.begin("dispatch");
  for (const truncated of [true, false]) {
    const id = String(truncated);
    delivery.observe({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "bash",
      args: { command },
    });
    delivery.observe({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "bash",
      isError: false,
      result: {
        content: [{ type: "text", text: output }],
        details: { truncation: { truncated } },
      },
    });
  }
  expect(f.events).toEqual([{ ...expected, id: "false" }]);
});

it("does not send unrelated shell output and retains wrapped PR creation", () => {
  const f = fixture();
  const observe = managedClaudeCommands(f.send);
  for (const command of [
    "npm test",
    "git diff",
    "cd /project && gh pr create --fill",
    "/bin/sh -lc 'gh pr create --fill'",
  ]) {
    observe(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: command, name: "Bash", input: { command } },
          ],
        },
      },
      ["dispatch"],
    );
    observe(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: command, content: output },
          ],
        },
      },
      ["dispatch"],
    );
  }
  expect(f.events.map((e) => e.command)).toEqual([
    "cd /project && gh pr create --fill",
    "/bin/sh -lc 'gh pr create --fill'",
  ]);
});
