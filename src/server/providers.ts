import { modelOptions } from "../../runtime/model-options.mjs";
import { Problem } from "./domain.js";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "../shared/types.js";
export type ModelInfo = import("../shared/models.js").ModelOption & {
  capabilities: string;
};
export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  attachments?: import("../shared/uploads.js").UploadedFile[];
  files?: { name: string; mime: string; data: string }[];
};
export type ChatInput = {
  model: string;
  effort?: string;
  instructions: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  workspaceKey?: string;
  steering?: import("./steering.js").SteeringInbox;
  maxTokens?: number;
  tools?: { name: string; description: string; inputSchema: any }[];
};
export type Chunk = {
  text?: string;
  usage?: unknown;
  externalId?: string;
  toolCall?: ToolCall;
  trace?: {
    id: string;
    kind: "message" | "tool";
    title: string;
    content: string;
    state?: string;
  };
};
export interface ProviderAdapter {
  models(secret: string): Promise<ModelInfo[]>;
  stream(secret: string, input: ChatInput): AsyncGenerator<Chunk>;
}
const adapters: Partial<Record<Provider, ProviderAdapter>> = {
  openai: {
    async models(secret) {
      const result = await new OpenAI({
        apiKey: secret,
        maxRetries: 1,
        timeout: 20000,
      }).models.list();
      return result.data
        .filter(
          (x) =>
            /^(gpt-|o[134])/.test(x.id) &&
            !/(audio|realtime|transcribe|tts|image)/.test(x.id),
        )
        .map((x) => ({
          id: x.id,
          name: x.id,
          capabilities: "Account catalog · text compatibility checked when run",
        }));
    },
    async *stream(secret, input) {
      const client = new OpenAI({
        apiKey: secret,
        maxRetries: 0,
        timeout: 180000,
      });
      const messages = input.messages.flatMap((m): any[] =>
        m.role === "tool"
          ? [
              {
                type: "function_call_output",
                call_id: m.toolCallId,
                output: m.content,
              },
            ]
          : [
              ...(m.content || m.files?.length
                ? [
                    {
                      role: m.role,
                      content: m.files?.length
                        ? [
                            { type: "input_text", text: m.content },
                            ...m.files.map((file) =>
                              file.mime === "application/pdf"
                                ? {
                                    type: "input_file",
                                    filename: file.name,
                                    file_data: `data:${file.mime};base64,${file.data}`,
                                  }
                                : {
                                    type: "input_image",
                                    image_url: `data:${file.mime};base64,${file.data}`,
                                    detail: "auto",
                                  },
                            ),
                          ]
                        : m.content,
                    },
                  ]
                : []),
              ...(m.toolCalls || []).map((t) => ({
                type: "function_call",
                call_id: t.id,
                name: t.name,
                arguments: JSON.stringify(t.arguments),
              })),
            ],
      );
      const stream = await client.responses.create(
        {
          model: input.model,
          ...(input.effort
            ? {
                reasoning: {
                  effort: input.effort as "low" | "medium" | "high",
                },
              }
            : {}),
          instructions: input.instructions || undefined,
          input: messages,
          tools: input.tools?.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          })),
          stream: true,
          store: false,
          max_output_tokens: input.maxTokens || 4096,
        },
        { signal: input.signal },
      );
      let completed = false;
      for await (const e of stream) {
        if (e.type === "response.output_text.delta") yield { text: e.delta };
        else if (
          e.type === "response.output_item.done" &&
          e.item.type === "function_call"
        ) {
          let args;
          try {
            args = JSON.parse(e.item.arguments);
          } catch {
            throw new Error("Invalid tool arguments from provider");
          }
          yield {
            toolCall: {
              id: e.item.call_id,
              name: e.item.name,
              arguments: args,
            },
          };
        } else if (e.type === "response.completed") {
          completed = true;
          yield { usage: e.response.usage, externalId: e.response.id };
        } else if (
          e.type === "response.failed" ||
          e.type === "response.incomplete" ||
          e.type === "error"
        )
          throw new Problem(
            422,
            "Provider stopped before completing the response. Partial output is saved.",
          );
      }
      if (!completed)
        throw new Problem(
          422,
          "Provider stream ended early. Partial output is saved.",
        );
    },
  },
  anthropic: {
    async models(secret) {
      const client = new Anthropic({
        apiKey: secret,
        maxRetries: 1,
        timeout: 20000,
      });
      const models: ModelInfo[] = [];
      for await (const m of client.models.list())
        models.push({
          id: m.id,
          name: m.display_name,
          capabilities: "Claude Messages API",
          ...modelOptions(m),
        });
      return models;
    },
    async *stream(secret, input) {
      const client = new Anthropic({
        apiKey: secret,
        maxRetries: 0,
        timeout: 180000,
      });
      const messages = input.messages
        .filter(
          (m) =>
            m.role !== "assistant" ||
            m.content.length > 0 ||
            !!m.toolCalls?.length,
        )
        .map((m): any =>
          m.role === "tool"
            ? {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: m.toolCallId,
                    content: m.content,
                    is_error: m.isError || undefined,
                  },
                ],
              }
            : {
                role: m.role,
                content: [
                  ...(m.content ? [{ type: "text", text: m.content }] : []),
                  ...(m.files || []).map((file) => ({
                    type:
                      file.mime === "application/pdf" ? "document" : "image",
                    source: {
                      type: "base64",
                      media_type: file.mime,
                      data: file.data,
                    },
                  })),
                  ...(m.toolCalls || []).map((t) => ({
                    type: "tool_use",
                    id: t.id,
                    name: t.name,
                    input: t.arguments,
                  })),
                ],
              },
        );
      const stream = await client.messages.create(
        {
          model: input.model,
          system: input.instructions || undefined,
          ...(input.effort
            ? {
                output_config: {
                  effort: input.effort as
                    "low" | "medium" | "high" | "xhigh" | "max",
                },
              }
            : {}),
          messages,
          tools: input.tools?.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
          max_tokens: input.maxTokens || 4096,
          stream: true,
        },
        { signal: input.signal },
      );
      const calls = new Map<
        number,
        { id: string; name: string; json: string; initial: any }
      >();
      let stopped = false;
      for await (const e of stream) {
        if (e.type === "message_stop") stopped = true;
        if (e.type === "message_delta" && e.delta.stop_reason === "max_tokens")
          throw new Problem(
            422,
            "Output token budget reached. Partial output is saved.",
          );
        if (
          e.type === "content_block_start" &&
          e.content_block.type === "tool_use"
        )
          calls.set(e.index, {
            id: e.content_block.id,
            name: e.content_block.name,
            json: "",
            initial: e.content_block.input,
          });
        if (e.type === "content_block_delta") {
          if (e.delta.type === "text_delta") yield { text: e.delta.text };
          if (e.delta.type === "input_json_delta") {
            const c = calls.get(e.index);
            if (c) c.json += e.delta.partial_json;
          }
        }
        if (e.type === "content_block_stop") {
          const c = calls.get(e.index);
          if (c)
            yield {
              toolCall: {
                id: c.id,
                name: c.name,
                arguments: c.json ? JSON.parse(c.json) : c.initial,
              },
            };
        }
        if (e.type === "message_start")
          yield { externalId: e.message.id, usage: e.message.usage };
        if (e.type === "message_delta") yield { usage: e.usage };
      }
      if (!stopped)
        throw new Problem(
          422,
          "Provider stream ended early. Partial output is saved.",
        );
    },
  },
};
export function adapter(provider: Provider) {
  const value = adapters[provider];
  if (!value)
    throw new Error(
      "This provider requires an isolated runtime that is not configured",
    );
  return value;
}
export function withTestAdapter(provider: Provider, value: ProviderAdapter) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test-only API");
  const previous = adapters[provider];
  adapters[provider] = value;
  return () => {
    adapters[provider] = previous;
  };
}
