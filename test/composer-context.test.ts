import { describe, expect, it } from "vitest";
import {
  latestAgentMessageId,
  quotesReply,
} from "../src/client/composerContext";

describe("latest agent message", () => {
  const reported = { id: "a2", cursor: [5, 9, 20] as const };
  it("keeps the reported message unless a newer agent message arrived", () => {
    const page = [
      { id: "a1", role: "assistant", cursor: [3, 9, 10] as const },
      { id: "u1", role: "user", cursor: [6, 0, 30] as const },
    ];
    expect(latestAgentMessageId(reported, page)).toBe("a2");
    expect(
      latestAgentMessageId(reported, [
        ...page,
        { id: "a3", role: "assistant", cursor: [6, 9, 31] as const },
      ]),
    ).toBe("a3");
    expect(latestAgentMessageId(null, page)).toBe("a1");
    expect(latestAgentMessageId(null, [])).toBeNull();
  });
  it("is unknown when the source does not report it", () => {
    expect(latestAgentMessageId(undefined, [])).toBeUndefined();
  });
});

describe("reply quotes", () => {
  const reply = {
    agentId: "g",
    conversationId: "c",
    messageId: "a1",
    content: "Answer",
  };
  const latest = (id: string | null, known = true, working = false) => ({
    conversationId: "c",
    id,
    known,
    working,
  });
  it("leaves out a whole-message reply to the agent's latest message in an idle thread", () => {
    expect(quotesReply(reply, "c", latest("a1"))).toBe(false);
    // Work in progress or queued may post newer messages before delivery.
    expect(quotesReply(reply, "c", latest("a1", true, true))).toBe(true);
  });
  it("quotes earlier messages, excerpts and your own prompts", () => {
    expect(quotesReply(reply, "c", latest("a2"))).toBe(true);
    expect(quotesReply({ ...reply, excerpt: true }, "c", latest("a1"))).toBe(
      true,
    );
    expect(
      quotesReply({ ...reply, messageId: "u1", mine: true }, "c", latest("a1")),
    ).toBe(true);
    expect(
      quotesReply(
        { ...reply, messageId: undefined, artifactId: "r" },
        "c",
        latest("a1"),
      ),
    ).toBe(true);
  });
  it("waits while its thread loads and quotes when the source cannot say", () => {
    expect(quotesReply(reply, "c", null)).toBeUndefined();
    expect(
      quotesReply(reply, "c", { ...latest("x"), conversationId: "other" }),
    ).toBeUndefined();
    expect(quotesReply(reply, "c", latest(null, false))).toBe(true);
    expect(quotesReply(reply, null, null)).toBe(true);
  });
});
