import { describe, expect, it } from "vitest";
import {
  MessageMetadata,
  readMessageMetadata,
  writeMessageMetadata,
} from "../src/shared/message-metadata.js";
import {
  InvalidRow,
  messageResponse,
  parseMessage,
} from "../src/server/row-schemas.js";

describe("shared message metadata", () => {
  it.each(["import", "native"] as const)(
    "reads declared origin %s",
    (origin) => {
      expect(readMessageMetadata(writeMessageMetadata({ origin }))).toEqual({
        origin,
      });
    },
  );
  it.each(["commentary", "final_answer"] as const)(
    "reads declared phase %s",
    (phase) => {
      expect(readMessageMetadata(writeMessageMetadata({ phase }))).toEqual({
        phase,
      });
    },
  );
  it.each(["pending", "sending", "delivered", "failed", null] as const)(
    "reads projected delivery %s",
    (delivery) => {
      const value = { delivery, completedMessageId: null, deliveryError: null };
      expect(readMessageMetadata(writeMessageMetadata(value))).toEqual(value);
    },
  );
  it.each([
    "review_continuation",
    "github_watch",
    "feed_digest",
    "agent_message",
    "agent_result",
  ] as const)("closes automation kind %s", (kind) => {
    const value = { automation: { kind } };
    expect(readMessageMetadata(writeMessageMetadata(value))).toEqual(value);
  });
  it.each([
    { state: "invented" },
    { origin: "invented" },
    { phase: "invented" },
    { delivery: "invented" },
    { automation: { kind: "invented" } },
  ])("rejects undeclared discriminator %j", (value) => {
    expect(MessageMetadata.safeParse(value).success).toBe(false);
    expect(() => readMessageMetadata(JSON.stringify(value))).toThrow();
    expect(readMessageMetadata(JSON.stringify(value), "fallback")).toEqual({});
  });
  it.each(["{", "null", "[]", '{"partial":"yes"}'])(
    "returns the client fallback for %s",
    (value) => {
      expect(readMessageMetadata(value, "fallback")).toEqual({});
    },
  );
  it("round trips representative current message writers", () => {
    const values: MessageMetadata[] = [
      { attachments: [], personal: true },
      { partial: true, messageId: "answer", native: true },
      { progress: true, round: 2, final: false },
      { progress: true, reply: { to: "user", published: true } },
      { native: true, migratedProjection: true },
      {
        sourceConversation: "conversation",
        sourceMessage: "message",
        original: { backend: "legacy" },
        selectedByUser: true,
      },
      {
        steeringId: "steering",
        automation: {
          kind: "agent_message",
          mailId: "mail",
          threadId: "thread",
          fromAgentId: "agent",
          fromName: "Agent",
        },
      },
    ];
    for (const value of values)
      expect(readMessageMetadata(writeMessageMetadata(value))).toEqual(value);
  });
  it("preserves approved historical keys on reads and HTTP serialization", () => {
    const historical = {
      origin: "native",
      backend: "hapi",
      epoch: 1,
      truncated: false,
      threadId: "thread",
      turnId: "turn",
    };
    const metadata = readMessageMetadata(JSON.stringify(historical));
    expect(metadata).toEqual(historical);
    expect(
      JSON.parse(
        messageResponse(
          parseMessage({
            id: "message",
            owner_id: "owner",
            conversation_id: "conversation",
            run_id: null,
            role: "assistant",
            content: "",
            created_at: 1,
            update_key: null,
            transcript_ordinal: null,
            revision: 1,
            metadata: JSON.stringify(historical),
          }),
        ).metadata,
      ),
    ).toEqual(historical);
    expect(() => writeMessageMetadata(metadata)).toThrow();
  });
  it("rejects misspelled new-write fields at both type and runtime boundaries", () => {
    // @ts-expect-error New writers cannot introduce an undeclared metadata field.
    expect(() => writeMessageMetadata({ progres: true })).toThrow();
  });
  it("preserves the server InvalidRow boundary", () => {
    const row = {
      id: "message",
      owner_id: "owner",
      conversation_id: "conversation",
      run_id: null,
      role: "user",
      content: "",
      metadata: '{"personal":"invalid"}',
      created_at: 1,
      update_key: null,
      transcript_ordinal: null,
      revision: 1,
    };
    expect(() => parseMessage(row)).toThrow(InvalidRow);
    try {
      parseMessage(row);
    } catch (error) {
      expect(error).toMatchObject({ table: "messages", column: "metadata" });
    }
  });
});
