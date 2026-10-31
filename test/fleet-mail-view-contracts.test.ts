import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { PublicMailMessage } from "../src/shared/agent-mail.js";

const message = {
  kind: "message",
  status: "queued",
  id: randomUUID(),
  from: "Same display name",
  to: "Recipient",
  preview: "Fixture",
  created_at: 1,
  error: null,
  files: 0,
};

it("keeps legacy mail responses compatible without inventing a remote owner", () => {
  expect(PublicMailMessage.parse(message)).toEqual(message);
});

it("preserves distinct machine identities for otherwise identical agent references", () => {
  const agentId = randomUUID();
  const from = {
    kind: "peer",
    machineId: "m_" + "1".repeat(64),
    agentId,
    name: "Same display name",
  };
  const to = { ...from, machineId: "m_" + "2".repeat(64) };
  const parsed = PublicMailMessage.parse({
    ...message,
    from_ref: from,
    to_ref: to,
    remote_conversation: {
      machineId: to.machineId,
      conversationId: randomUUID(),
    },
  });
  expect(parsed.from_ref).toEqual(from);
  expect(parsed.to_ref).toEqual(to);
  expect(parsed.remote_conversation?.machineId).toBe(to.machineId);
  expect(
    PublicMailMessage.safeParse({
      ...message,
      from_ref: { ...from, machineId: "https://untrusted.example" },
    }).success,
  ).toBe(false);
});
