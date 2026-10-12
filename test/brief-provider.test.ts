import { afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "loop-brief-provider-"));
vi.stubEnv("LOOP_DATA_DIR", dir);
const { adapter } = await import("../src/server/providers");
const { outputJsonSchema } = await import("../src/server/briefs/schema");
const { db } = await import("../src/server/db");
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it.each(["openai", "anthropic"] as const)(
  "forces one submit_brief call through the actual %s SDK",
  async (provider) => {
    let body: any;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      const events =
        provider === "openai"
          ? [
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: "brief",
                  name: "submit_brief",
                  arguments: '{"items":[]}',
                },
              },
              {
                type: "response.completed",
                response: { id: "response", usage: {} },
              },
            ]
          : [
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "brief",
                  name: "submit_brief",
                  input: { items: [] },
                },
              },
              { type: "content_block_stop", index: 0 },
              { type: "message_stop" },
            ];
      return new Response(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const chunks = [];
    for await (const chunk of adapter(provider).stream("fixture-secret", {
      model: "chosen-model",
      instructions: "Maintain the brief",
      messages: [{ role: "user", content: "EVENTS" }],
      signal: new AbortController().signal,
      maxTokens: 4096,
      toolChoice: "submit_brief",
      tools: [
        {
          name: "submit_brief",
          description: "Submit",
          inputSchema: outputJsonSchema,
        },
      ],
    }))
      chunks.push(chunk);
    expect(body.model).toBe("chosen-model");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("submit_brief");
    if (provider === "openai") {
      expect(body.tool_choice).toEqual({
        type: "function",
        name: "submit_brief",
      });
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.max_output_tokens).toBe(4096);
      expect(body.tools[0].parameters).toEqual(outputJsonSchema);
    } else {
      expect(body.tool_choice).toEqual({
        type: "tool",
        name: "submit_brief",
        disable_parallel_tool_use: true,
      });
      expect(body.max_tokens).toBe(4096);
      expect(body.tools[0].input_schema).toEqual(outputJsonSchema);
    }
    expect(chunks).toContainEqual({
      toolCall: { id: "brief", name: "submit_brief", arguments: { items: [] } },
    });
  },
);
