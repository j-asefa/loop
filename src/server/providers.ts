import { modelOptions } from "../../runtime/model-options.ts";
import { Problem } from "./domain.js";
import OpenAI from "openai";
import { toResponseInputItem } from "openai/lib/responses/ResponseInputItems";
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
  /**
   * The provider's complete, ordered assistant content for this turn when it
   * called a tool, searched for tools or paused: thinking or reasoning, text,
   * search calls, search results and tool uses in the positions the provider
   * returned them. Replayed in place of `content` and `toolCalls` on later
   * requests of the same run so signed thinking stays intact and discovered
   * tools stay loaded. Opaque to Loop, which still reads `content` and
   * `toolCalls`.
   */
  providerContent?: unknown[];
  /** This assistant turn was a provider pause (see Chunk.pauseTurn), not an answer. */
  paused?: boolean;
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
  steering?: import("./steering.js").SteeringInbox;
  maxTokens?: number;
  tools?: {
    name: string;
    description: string;
    inputSchema: any;
    /**
     * Keep this tool out of the model's context until it discovers it through
     * the provider's tool search. Ignored when the provider or model has no
     * tool search, or when toolChoice forces a tool.
     */
    deferLoading?: boolean;
  }[];
  /** Force one named tool for structured projections; omitted for ordinary chat. */
  toolChoice?: string;
};
export type Chunk = {
  text?: string;
  usage?: unknown;
  externalId?: string;
  toolCall?: ToolCall;
  /** See ChatMessage.providerContent. Emitted once, after the turn's blocks. */
  providerContent?: unknown[];
  /**
   * The provider paused a server-side loop (Anthropic `pause_turn`). The turn
   * is not an answer: replay `providerContent` as the last message and request
   * again so the provider can resume.
   */
  pauseTurn?: boolean;
};
/**
 * Tool search keeps deferred definitions out of the context window until the
 * model searches for them. Loop's own tools stay loaded; connected MCP tools
 * are deferred. A forced tool must already be loaded, so projections defer
 * nothing.
 */
function deferredTools(input: ChatInput) {
  if (input.toolChoice) return false;
  return !!input.tools?.some((t) => t.deferLoading);
}
/**
 * OpenAI documents tool search for gpt-5.4 and later models only, and the
 * nano variant's capability table leaves it out, so nano ids (including
 * dated snapshots) keep the eager catalog.
 */
export function openaiToolSearch(model: string) {
  const m = /^gpt-(\d+)(?:\.(\d+))?(-nano)?(?:-|$)/.exec(model);
  if (!m || m[3]) return false;
  const major = Number(m[1]),
    minor = Number(m[2] || 0);
  return major > 5 || (major === 5 && minor >= 4);
}
/**
 * Anthropic documents tool search from Claude 4.5 onwards (Opus, Sonnet and
 * Haiku 4.5, the 4.6 to 4.8 and 5.x families, Fable and Mythos). Opus 4.1 and
 * earlier reject it, so unknown or older ids keep the eager catalog. A
 * trailing date is not a minor version.
 */
export function anthropicToolSearch(model: string) {
  if (/^claude-(?:fable|mythos)-/.test(model)) return true;
  const m = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(
    model,
  );
  if (!m) return false;
  const major = Number(m[1]),
    minor = Number(m[2] || 0);
  return major > 4 || (major === 4 && minor >= 5);
}
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
          : m.providerContent
            ? m.providerContent
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
      const search = deferredTools(input) && openaiToolSearch(input.model);
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
          ...(input.toolChoice
            ? {
                tool_choice: {
                  type: "function" as const,
                  name: input.toolChoice,
                },
                parallel_tool_calls: false,
              }
            : {}),
          input: messages,
          tools: input.tools && [
            ...(search ? [{ type: "tool_search" as const }] : []),
            ...input.tools.map((t) => ({
              type: "function" as const,
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
              strict: false,
              ...(search && t.deferLoading ? { defer_loading: true } : {}),
            })),
          ],
          stream: true,
          store: false,
          max_output_tokens: input.maxTokens || 4096,
        },
        { signal: input.signal },
      );
      let completed = false;
      // Output items in order, normalized by the SDK into input items (output-
      // only fields dropped). Replayed when the model called or searched for
      // tools, so the encrypted reasoning behind the call travels with it.
      const items: Record<string, unknown>[] = [];
      for await (const e of stream) {
        if (
          e.type === "response.output_item.done" &&
          (e.item.type === "reasoning" ||
            e.item.type === "message" ||
            e.item.type === "function_call" ||
            e.item.type === "tool_search_call" ||
            e.item.type === "tool_search_output")
        ) {
          const item = toResponseInputItem(e.item);
          if (item) items.push(item as unknown as Record<string, unknown>);
        }
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
          if (
            items.some(
              (item) =>
                item.type === "function_call" ||
                item.type === "tool_search_call" ||
                item.type === "tool_search_output",
            )
          )
            yield { providerContent: items };
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
            !!m.toolCalls?.length ||
            !!m.providerContent?.length,
        )
        .map((m): any =>
          m.role === "assistant" && m.providerContent
            ? { role: "assistant", content: m.providerContent }
            : m.role === "tool"
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
      const search = deferredTools(input) && anthropicToolSearch(input.model);
      const stream = await client.messages.create(
        {
          model: input.model,
          system: input.instructions || undefined,
          ...(input.toolChoice
            ? {
                tool_choice: {
                  type: "tool" as const,
                  name: input.toolChoice,
                  disable_parallel_tool_use: true,
                },
              }
            : {}),
          ...(input.effort
            ? {
                output_config: {
                  effort: input.effort as
                    "low" | "medium" | "high" | "xhigh" | "max",
                },
              }
            : {}),
          messages,
          tools: input.tools && [
            ...(search
              ? [
                  {
                    type: "tool_search_tool_bm25_20251119" as const,
                    name: "tool_search_tool_bm25" as const,
                  },
                ]
              : []),
            ...input.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
              ...(search && t.deferLoading ? { defer_loading: true } : {}),
            })),
          ],
          max_tokens: input.maxTokens || 4096,
          stream: true,
        },
        { signal: input.signal },
      );
      // Every content block in order, rebuilt from the stream as the API
      // returned it, including thinking blocks and their signatures. When the
      // model called a tool, searched for tools or paused a server-side loop,
      // the whole sequence is replayed unchanged on the next request.
      const blocks = new Map<number, { block: any; json: string }>();
      let replay = false,
        paused = false,
        stopped = false;
      for await (const e of stream) {
        if (e.type === "message_stop") stopped = true;
        if (e.type === "message_delta" && e.delta.stop_reason === "max_tokens")
          throw new Problem(
            422,
            "Output token budget reached. Partial output is saved.",
          );
        if (e.type === "message_delta" && e.delta.stop_reason === "pause_turn")
          paused = true;
        if (e.type === "content_block_start") {
          const type = e.content_block.type;
          if (
            type === "text" ||
            type === "thinking" ||
            type === "redacted_thinking" ||
            type === "tool_use" ||
            type === "server_tool_use" ||
            type === "tool_search_tool_result"
          )
            blocks.set(e.index, {
              block: structuredClone(e.content_block),
              json: "",
            });
          if (
            type === "tool_use" ||
            type === "server_tool_use" ||
            type === "tool_search_tool_result"
          )
            replay = true;
        }
        if (e.type === "content_block_delta") {
          const b = blocks.get(e.index);
          if (e.delta.type === "text_delta") {
            if (b) b.block.text += e.delta.text;
            yield { text: e.delta.text };
          }
          if (e.delta.type === "input_json_delta" && b)
            b.json += e.delta.partial_json;
          if (e.delta.type === "thinking_delta" && b)
            b.block.thinking += e.delta.thinking;
          if (e.delta.type === "signature_delta" && b)
            b.block.signature = e.delta.signature;
        }
        if (e.type === "content_block_stop") {
          const b = blocks.get(e.index);
          if (b && b.json) b.block.input = JSON.parse(b.json);
          if (b?.block.type === "tool_use")
            yield {
              toolCall: {
                id: b.block.id,
                name: b.block.name,
                arguments: b.block.input,
              },
            };
        }
        if (e.type === "message_start")
          yield { externalId: e.message.id, usage: e.message.usage };
        if (e.type === "message_delta") yield { usage: e.usage };
      }
      if (replay || paused)
        yield {
          providerContent: [...blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, b]) => b.block),
          ...(paused ? { pauseTurn: true } : {}),
        };
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
