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
const { openaiToolSearch, anthropicToolSearch } =
  await import("../src/server/providers");
const deferredTools = [
  {
    name: "loop_plan",
    description: "Loop's own tool",
    inputSchema: { type: "object" },
  },
  {
    name: "loop_tool_abc",
    description: "Fixture MCP metrics: query latency",
    inputSchema: { type: "object" },
    deferLoading: true,
  },
];
it("defers connected MCP tools behind Anthropic tool search and replays the ordered assistant content", async () => {
  expect(
    [
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
    ].map(anthropicToolSearch),
  ).toEqual(Array(8).fill(true));
  expect(
    [
      "claude-opus-4-1",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-haiku-20241022",
      "fixture",
    ].map(anthropicToolSearch),
  ).toEqual(Array(7).fill(false));
  const bodies: any[] = [];
  const searchUse = {
    type: "server_tool_use",
    id: "srvtoolu_1",
    name: "tool_search_tool_bm25",
    input: {},
    caller: { type: "direct" },
  };
  const searchResult = {
    type: "tool_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: {
      type: "tool_search_tool_search_result",
      tool_references: [{ type: "tool_reference", tool_name: "loop_tool_abc" }],
    },
  };
  const start = {
    type: "message_start",
    message: {
      id: "msg_search",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  };
  const text = (index: number, value: string) => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: value },
    },
    { type: "content_block_stop", index },
  ];
  // Adaptive thinking (on by default for Claude 5) produces a signed thinking
  // block and may add a redacted one; both must come back unchanged.
  const thinking = (index: number) => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: "Consider the catalog." },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: "sig_fixture" },
    },
    { type: "content_block_stop", index },
    {
      type: "content_block_start",
      index: index + 1,
      content_block: { type: "redacted_thinking", data: "opaque-fixture" },
    },
    { type: "content_block_stop", index: index + 1 },
  ];
  const search = (index: number) => [
    { type: "content_block_start", index, content_block: searchUse },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: '{"query":"latency"}' },
    },
    { type: "content_block_stop", index },
    {
      type: "content_block_start",
      index: index + 1,
      content_block: searchResult,
    },
    { type: "content_block_stop", index: index + 1 },
  ];
  const stop = (reason: string) => [
    {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 6 },
    },
    { type: "message_stop" },
  ];
  // The documented interleaved shape: thinking, text, search, result, text, tool use.
  let events: any[] = [
    start,
    ...thinking(0),
    ...text(2, "Searching. "),
    ...search(3),
    ...text(5, "Found it."),
    {
      type: "content_block_start",
      index: 6,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "loop_tool_abc",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 6,
      delta: { type: "input_json_delta", partial_json: '{"query":"p99"}' },
    },
    { type: "content_block_stop", index: 6 },
    ...stop("tool_use"),
  ];
  vi.stubGlobal("fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return sse(events);
  });
  const stream = (messages: any[], extra: object = {}) =>
    adapter("anthropic").stream("fixture-secret", {
      model: "claude-sonnet-5-5",
      instructions: "Instructions",
      messages,
      signal: new AbortController().signal,
      tools: deferredTools,
      ...extra,
    });
  const collect = async (messages: any[], extra: object = {}) => {
    const chunks: any[] = [];
    for await (const c of stream(messages, extra)) chunks.push(c);
    return chunks;
  };
  let chunks = await collect([{ role: "user", content: "Latency?" }]);
  expect(bodies[0].tools).toEqual([
    { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    {
      name: "loop_plan",
      description: "Loop's own tool",
      input_schema: { type: "object" },
    },
    {
      name: "loop_tool_abc",
      description: "Fixture MCP metrics: query latency",
      input_schema: { type: "object" },
      defer_loading: true,
    },
  ]);
  const content = [
    {
      type: "thinking",
      thinking: "Consider the catalog.",
      signature: "sig_fixture",
    },
    { type: "redacted_thinking", data: "opaque-fixture" },
    { type: "text", text: "Searching. " },
    { ...searchUse, input: { query: "latency" } },
    searchResult,
    { type: "text", text: "Found it." },
    {
      type: "tool_use",
      id: "tool-1",
      name: "loop_tool_abc",
      input: { query: "p99" },
    },
  ];
  expect(chunks.filter((c) => c.providerContent)).toEqual([
    { providerContent: content },
  ]);
  expect(
    chunks
      .filter((c) => c.text)
      .map((c) => c.text)
      .join(""),
  ).toBe("Searching. Found it.");
  // The search call is never surfaced as a tool call for Loop to execute.
  expect(chunks.filter((c) => c.toolCall)).toEqual([
    {
      toolCall: {
        id: "tool-1",
        name: "loop_tool_abc",
        arguments: { query: "p99" },
      },
    },
  ]);
  // The next round passes the assistant content back unchanged.
  await collect([
    { role: "user", content: "Latency?" },
    {
      role: "assistant",
      content: "Searching. Found it.",
      toolCalls: [
        { id: "tool-1", name: "loop_tool_abc", arguments: { query: "p99" } },
      ],
      providerContent: content,
    },
    { role: "tool", content: "12 ms", toolCallId: "tool-1" },
  ]);
  expect(bodies[1].messages[1]).toEqual({ role: "assistant", content });
  expect(bodies[1].messages[2].content[0]).toMatchObject({
    type: "tool_result",
    tool_use_id: "tool-1",
  });
  // A paused server-side loop is not an answer: the turn's content comes
  // back to be replayed as the last message, with no client tool call.
  events = [
    start,
    ...thinking(0),
    ...text(2, "Looking up tools. "),
    ...search(3),
    ...stop("pause_turn"),
  ];
  chunks = await collect([{ role: "user", content: "Latency?" }]);
  const pausedContent = [
    content[0],
    content[1],
    { type: "text", text: "Looking up tools. " },
    content[3],
    content[4],
  ];
  expect(chunks.filter((c) => c.providerContent)).toEqual([
    { providerContent: pausedContent, pauseTurn: true },
  ]);
  expect(chunks.some((c) => c.toolCall)).toBe(false);
  await collect([
    { role: "user", content: "Latency?" },
    {
      role: "assistant",
      content: "Looking up tools. ",
      providerContent: pausedContent,
    },
  ]);
  expect(bodies[3].messages.at(-1)).toEqual({
    role: "assistant",
    content: pausedContent,
  });
  // A later round may call an already-loaded tool without searching. Its
  // thinking must still come back complete, so every tool-use round replays.
  events = [
    start,
    ...thinking(0),
    {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "tool-2",
        name: "loop_plan",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"steps":[]}' },
    },
    { type: "content_block_stop", index: 2 },
    ...stop("tool_use"),
  ];
  const searchedTurn = {
    role: "assistant",
    content: "Searching. Found it.",
    toolCalls: [
      { id: "tool-1", name: "loop_tool_abc", arguments: { query: "p99" } },
    ],
    providerContent: content,
  };
  chunks = await collect([
    { role: "user", content: "Latency?" },
    searchedTurn,
    { role: "tool", content: "12 ms", toolCallId: "tool-1" },
  ]);
  const followUp = [
    content[0],
    content[1],
    {
      type: "tool_use",
      id: "tool-2",
      name: "loop_plan",
      input: { steps: [] },
    },
  ];
  expect(chunks.filter((c) => c.providerContent)).toEqual([
    { providerContent: followUp },
  ]);
  await collect([
    { role: "user", content: "Latency?" },
    searchedTurn,
    { role: "tool", content: "12 ms", toolCallId: "tool-1" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "tool-2", name: "loop_plan", arguments: { steps: [] } },
      ],
      providerContent: followUp,
    },
    { role: "tool", content: "ok", toolCallId: "tool-2" },
  ]);
  expect(bodies[5].messages.map((m: any) => m.content)).toEqual([
    [{ type: "text", text: "Latency?" }],
    content,
    [{ type: "tool_result", tool_use_id: "tool-1", content: "12 ms" }],
    followUp,
    [{ type: "tool_result", tool_use_id: "tool-2", content: "ok" }],
  ]);
  // Plain answers keep the existing reconstruction and carry no provider content.
  events = [
    start,
    ...thinking(0),
    ...text(2, "Plain answer."),
    ...stop("end_turn"),
  ];
  chunks = await collect([{ role: "user", content: "Hi" }]);
  expect(chunks.some((c) => c.providerContent || c.pauseTurn)).toBe(false);
  // A forced tool must already be loaded: projections defer nothing.
  await collect([{ role: "user", content: "Project" }], {
    toolChoice: "loop_tool_abc",
  });
  expect(bodies[7].tools.map((t: any) => t.type)).toEqual([
    undefined,
    undefined,
  ]);
  expect(bodies[7].tools.map((t: any) => t.defer_loading)).toEqual([
    undefined,
    undefined,
  ]);
  // Models without tool search keep the eager catalog and never see the tool.
  await collect([{ role: "user", content: "Latency?" }], {
    model: "claude-opus-4-1",
  });
  expect(bodies[8].tools).toEqual([
    {
      name: "loop_plan",
      description: "Loop's own tool",
      input_schema: { type: "object" },
    },
    {
      name: "loop_tool_abc",
      description: "Fixture MCP metrics: query latency",
      input_schema: { type: "object" },
    },
  ]);
});
it("defers connected MCP tools behind OpenAI tool search on supporting models and replays normalized items in order", async () => {
  expect(
    [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-mini-2026-03-17",
      "gpt-5.10",
      "gpt-6",
      "gpt-6.1",
    ].map(openaiToolSearch),
  ).toEqual(Array(6).fill(true));
  // Nano's capability table omits tool search; dated snapshots follow suit.
  expect(
    [
      "gpt-5.4-nano",
      "gpt-5.4-nano-2026-03-17",
      "gpt-5",
      "gpt-5.3",
      "gpt-4.1",
      "gpt-4o",
      "o3",
      "fixture",
    ].map(openaiToolSearch),
  ).toEqual(Array(8).fill(false));
  const bodies: any[] = [];
  const searchCall = {
    type: "tool_search_call",
    id: "ts_1",
    call_id: "call_search",
    arguments: { query: "latency" },
    execution: "server",
    status: "completed",
  };
  const searchOutput = {
    type: "tool_search_output",
    id: "tso_1",
    call_id: "call_search",
    execution: "server",
    status: "completed",
    tools: [{ type: "function", name: "loop_tool_abc" }],
  };
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Found it.", annotations: [] }],
  };
  const functionCall = {
    type: "function_call",
    id: "fc_1",
    call_id: "tool-1",
    name: "loop_tool_abc",
    arguments: '{"query":"p99"}',
    status: "completed",
  };
  // Stateless requests return encrypted reasoning that must travel with the
  // search and the function call it produced.
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    summary: [],
    encrypted_content: "enc-fixture",
  };
  vi.stubGlobal("fetch", async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return sse([
      {
        type: "response.output_item.done",
        item: { ...reasoning, created_by: "model" },
      },
      // Output-only fields must not reach the next request.
      {
        type: "response.output_item.done",
        item: { ...searchCall, created_by: "model" },
      },
      {
        type: "response.output_item.done",
        item: { ...searchOutput, created_by: "server" },
      },
      { type: "response.output_text.delta", delta: "Found it." },
      { type: "response.output_item.done", item: message },
      { type: "response.output_item.done", item: functionCall },
      {
        type: "response.completed",
        response: {
          id: "resp_search",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
  });
  const chunks: any[] = [];
  for await (const c of adapter("openai").stream("fixture-secret", {
    model: "gpt-5.4",
    instructions: "Instructions",
    messages: [{ role: "user", content: "Latency?" }],
    signal: new AbortController().signal,
    tools: deferredTools,
  }))
    chunks.push(c);
  expect(bodies[0].tools).toEqual([
    { type: "tool_search" },
    {
      type: "function",
      name: "loop_plan",
      description: "Loop's own tool",
      parameters: { type: "object" },
      strict: false,
    },
    {
      type: "function",
      name: "loop_tool_abc",
      description: "Fixture MCP metrics: query latency",
      parameters: { type: "object" },
      strict: false,
      defer_loading: true,
    },
  ]);
  const items = [reasoning, searchCall, searchOutput, message, functionCall];
  expect(chunks.filter((c) => c.providerContent)).toEqual([
    { providerContent: items },
  ]);
  expect(chunks.filter((c) => c.toolCall)).toHaveLength(1);
  for await (const _ of adapter("openai").stream("fixture-secret", {
    model: "gpt-5.4",
    instructions: "Instructions",
    messages: [
      { role: "user", content: "Latency?" },
      {
        role: "assistant",
        content: "Found it.",
        toolCalls: [
          {
            id: "tool-1",
            name: "loop_tool_abc",
            arguments: { query: "p99" },
          },
        ],
        providerContent: items,
      },
      { role: "tool", content: "12 ms", toolCallId: "tool-1" },
    ],
    signal: new AbortController().signal,
    tools: deferredTools,
  })) {
  }
  expect(bodies[1].input.slice(1)).toEqual([
    ...items,
    { type: "function_call_output", call_id: "tool-1", output: "12 ms" },
  ]);
  // A later function call without a search still carries its reasoning.
  const laterReasoning = {
    ...reasoning,
    id: "rs_2",
    encrypted_content: "enc-2",
  };
  const laterCall = {
    ...functionCall,
    id: "fc_2",
    call_id: "tool-2",
    name: "loop_plan",
    arguments: "{}",
  };
  const openai = async (events: any[], prompt: string) => {
    vi.stubGlobal("fetch", async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return sse([
        ...events,
        {
          type: "response.completed",
          response: {
            id: "resp_" + prompt,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]);
    });
    const out: any[] = [];
    for await (const c of adapter("openai").stream("fixture-secret", {
      model: "gpt-5.4",
      instructions: "Instructions",
      messages: [{ role: "user", content: prompt }],
      signal: new AbortController().signal,
      tools: deferredTools,
    }))
      out.push(c);
    return out;
  };
  const later = await openai(
    [
      {
        type: "response.output_item.done",
        item: { ...laterReasoning, created_by: "model" },
      },
      { type: "response.output_item.done", item: laterCall },
    ],
    "Plan?",
  );
  expect(later.filter((c) => c.providerContent)).toEqual([
    { providerContent: [laterReasoning, laterCall] },
  ]);
  // A plain answer carries none.
  const plain = await openai(
    [
      { type: "response.output_item.done", item: { ...reasoning, id: "rs_3" } },
      { type: "response.output_text.delta", delta: "Plain." },
      { type: "response.output_item.done", item: { ...message, id: "msg_3" } },
    ],
    "Hi",
  );
  expect(plain.some((c) => c.providerContent)).toBe(false);
  // Older models and the nano variant keep the full catalog loaded and
  // never see tool_search.
  for (const model of ["gpt-4.1", "gpt-5.4-nano", "gpt-5.4-nano-2026-03-17"]) {
    vi.stubGlobal("fetch", async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return sse([
        {
          type: "response.completed",
          response: {
            id: "resp_eager",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]);
    });
    for await (const _ of adapter("openai").stream("fixture-secret", {
      model,
      instructions: "Instructions",
      messages: [{ role: "user", content: "Latency?" }],
      signal: new AbortController().signal,
      tools: deferredTools,
    })) {
    }
    const body = bodies.at(-1);
    expect(body.model).toBe(model);
    expect(body.tools.map((t: any) => t.type)).toEqual([
      "function",
      "function",
    ]);
    expect(body.tools.map((t: any) => t.defer_loading)).toEqual([
      undefined,
      undefined,
    ]);
  }
});
