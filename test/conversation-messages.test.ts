import { workspaceApi } from "../src/shared/workspace-api.js";
import { expect, it } from "vitest";
import {
  conversationRefreshCursor,
  type ConversationMessage,
} from "../src/client/conversationMessages";

it("reopens pagination when a live turn grows beyond a page despite its shared answer placeholder", () => {
  const entry = (id: string, progress = true): ConversationMessage =>
    workspaceApi.conversation.response.shape.messages.element.parse({
      id,
      owner_id: "owner",
      conversation_id: "conversation",
      run_id: "run",
      role: "assistant",
      content: id,
      created_at: 1000,
      metadata: JSON.stringify(
        progress ? { progress: true } : { partial: true },
      ),
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
