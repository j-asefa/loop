import { it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "loop-provider-contract-"));
process.env.LOOP_DATA_DIR = dir;
const { adapter } = await import("../src/server/providers");
const { db } = await import("../src/server/db");
function sse(events: any[]) {
  return new Response(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
afterAll(() => {
  vi.unstubAllGlobals();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
it("uses the actual OpenAI SDK to send selected model and decode text, tool calls and usage", async () => {
  let body: any;
  vi.stubGlobal("fetch", async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return sse([
      { type: "response.output_text.delta", delta: "Contract fixture." },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "tool-1",
          name: "loop_tool_0",
          arguments: '{"query":"latency"}',
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          usage: { input_tokens: 12, output_tokens: 8 },
        },
      },
    ]);
  });
  const chunks = [];
  for await (const c of adapter("openai").stream("fixture-secret", {
    model: "selected-model-fixture",
    effort: "xhigh",
    instructions: "Instructions",
    messages: [
      {
        role: "user",
        content: "Question",
        files: [
          { name: "photo.png", mime: "image/png", data: "aGVsbG8=" },
          { name: "report.pdf", mime: "application/pdf", data: "cGRm" },
        ],
      },
    ],
    signal: new AbortController().signal,
    tools: [
      {
        name: "loop_tool_0",
        description: "Fixture",
        inputSchema: { type: "object" },
      },
    ],
  }))
    chunks.push(c);
  expect(body.model).toBe("selected-model-fixture");
  expect(body.reasoning.effort).toBe("xhigh");
  expect(body.input[0].content).toEqual([
    { type: "input_text", text: "Question" },
    {
      type: "input_image",
      image_url: "data:image/png;base64,aGVsbG8=",
      detail: "auto",
    },
    {
      type: "input_file",
      filename: "report.pdf",
      file_data: "data:application/pdf;base64,cGRm",
    },
  ]);
  expect(body.store).toBe(false);
  expect(body.tools[0].strict).toBe(false);
  expect(chunks).toContainEqual({ text: "Contract fixture." });
  expect(chunks).toContainEqual({
    toolCall: {
      id: "tool-1",
      name: "loop_tool_0",
      arguments: { query: "latency" },
    },
  });
  expect(chunks.at(-1)?.externalId).toBe("resp_fixture");
});
it.each([false, true])(
  "uses the actual Anthropic SDK to preserve tool-result context (isError=%s) and stream selected model",
  async (isError) => {
    let body: any;
    vi.stubGlobal("fetch", async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return sse([
        {
          type: "message_start",
          message: {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            content: [],
            model: "selected-claude-fixture",
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Reviewed fixture." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 6 },
        },
        { type: "message_stop" },
      ]);
    });
    const chunks = [];
    for await (const c of adapter("anthropic").stream("fixture-secret", {
      model: "selected-claude-fixture",
      effort: "max",
      instructions: "Review",
      messages: [
        {
          role: "user",
          content: "Query",
          files: [
            { name: "report.pdf", mime: "application/pdf", data: "cGRm" },
            { name: "photo.png", mime: "image/png", data: "aGVsbG8=" },
          ],
        },
        { role: "assistant", content: "" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tool-1", name: "metrics", arguments: { q: "x" } }],
        },
        {
          role: "tool",
          content: "Tool response",
          toolCallId: "tool-1",
          isError,
        },
      ],
      signal: new AbortController().signal,
      maxTokens: 222,
    }))
      chunks.push(c);
    expect(body.model).toBe("selected-claude-fixture");
    expect(body.output_config.effort).toBe("max");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Query" },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
    ]);
    expect(body.max_tokens).toBe(222);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content[0]).toMatchObject({
      type: "tool_use",
      id: "tool-1",
    });
    expect(body.messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "Tool response",
    });
    expect(body.messages.at(-1).content[0].is_error).toBe(isError || undefined);
    expect(chunks).toContainEqual({ text: "Reviewed fixture." });
  },
);
it("does not mark prematurely ended or token-limited streams successful", async () => {
  vi.stubGlobal("fetch", async () =>
    sse([{ type: "response.output_text.delta", delta: "Partial" }]),
  );
  await expect(
    (async () => {
      for await (const _ of adapter("openai").stream("fixture", {
        model: "fixture",
        instructions: "",
        messages: [{ role: "user", content: "q" }],
        signal: new AbortController().signal,
      })) {
      }
    })(),
  ).rejects.toThrow(/ended early/);
  vi.stubGlobal("fetch", async () =>
    sse([
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 10 },
      },
    ]),
  );
  await expect(
    (async () => {
      for await (const _ of adapter("anthropic").stream("fixture", {
        model: "fixture",
        instructions: "",
        messages: [{ role: "user", content: "q" }],
        signal: new AbortController().signal,
      })) {
      }
    })(),
  ).rejects.toThrow(/budget/);
});
