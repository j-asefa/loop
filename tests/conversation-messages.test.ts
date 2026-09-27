import { expect, it } from "vitest";
import {
  mergeConversationMessages,
  conversationRefreshCursor,
  type ConversationMessage,
} from "../src/client/conversationMessages";

it("replaces a streamed update with its saved answer while preserving earlier conversation pages", () => {
  const entry = (
    id: string,
    cursor: [number, number, number],
    metadata = "{}",
  ): ConversationMessage => ({
    id,
    cursor,
    owner_id: "owner",
    conversation_id: "conversation",
    run_id: "run",
    role: "assistant",
    content: id,
    created_at: 1000,
    metadata,
  });
  const firstPrompt = {
    ...entry("prompt", [10, 0, 10]),
    role: "user" as const,
  };
  const progress = entry("trace:70", [10, 1, 70], '{"progress":true}');
  const streaming = entry("trace:71", [10, 1, 71], '{"progress":true}');
  const queuedPrompt = {
    ...entry("next-prompt", [11, 0, 11]),
    role: "user" as const,
  };
  const final = entry("answer", [10, 2, 12], '{"completedTraceId":71}');
  const merged = mergeConversationMessages(
    [queuedPrompt, streaming, progress, firstPrompt],
    [final, queuedPrompt],
  );
  expect(merged.map((message) => message.id)).toEqual([
    "prompt",
    "trace:70",
    "answer",
    "next-prompt",
  ]);
  expect(
    mergeConversationMessages(merged, [streaming, progress, firstPrompt]).map(
      (message) => message.id,
    ),
  ).toEqual(["prompt", "trace:70", "answer", "next-prompt"]);
});

it("reopens pagination when a live turn grows beyond a page despite its shared answer placeholder", () => {
  const entry = (id: string, progress = true): ConversationMessage => ({
    id,
    owner_id: "owner",
    conversation_id: "conversation",
    run_id: "run",
    role: "assistant",
    content: id,
    created_at: 1000,
    metadata: JSON.stringify(progress ? { progress: true } : { partial: true }),
    cursor: [1, progress ? 1 : 2, 1],
    run_state: "running",
  });
  const placeholder = entry("answer", false),
    original = entry("trace:1"),
    recent = entry("trace:80");
  expect(
    conversationRefreshCursor(
      [original, placeholder],
      [recent, placeholder],
      null,
      "gap-cursor",
    ),
  ).toBe("gap-cursor");
  expect(
    conversationRefreshCursor(
      [original, recent, placeholder],
      [recent, placeholder],
      "older-cursor",
      "newer-cursor",
    ),
  ).toBe("older-cursor");
  expect(
    conversationRefreshCursor(
      [original, recent, placeholder],
      [recent, placeholder],
      null,
      "newer-cursor",
    ),
  ).toBeNull();
  expect(
    conversationRefreshCursor([], [original, placeholder], null, "first-page"),
  ).toBe("first-page");
});
