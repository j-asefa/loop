import { expect, it } from "vitest";
import {
  readRunPayload,
  writeRunPayload,
  type RunPayload,
} from "../src/shared/run-payload";

it.each([
  {},
  {
    agentId: "agent",
    provider: "openai",
    folderId: null,
    teamId: "team",
    attachmentIds: [],
  },
  {
    agentId: "preview",
    provider: "openai",
    model: "fixture",
    previewFixture: true,
  },
  { importId: "import" },
  {
    name: "Tool",
    agentId: "agent",
    connectionId: "connection",
    tool: "read",
    arguments: { count: 2 },
    idempotencyKey: "request",
  },
] satisfies RunPayload[])(
  "round-trips a run payload as JSON text: %j",
  (payload) => {
    const stored = writeRunPayload(payload);
    expect(typeof stored).toBe("string");
    expect(readRunPayload(stored)).toEqual(payload);
  },
);
it.each([
  "not JSON",
  "null",
  "[]",
  '{"accidental":true}',
  '{"provider":"unknown"}',
  '{"permissionMode":"unknown"}',
  '{"teamId":4}',
])(
  "rejects invalid full payloads and gives clients a fallback: %s",
  (value) => {
    expect(() => readRunPayload(value)).toThrow();
    expect(readRunPayload(value, "fallback")).toEqual({});
  },
);
it("keeps recovery field validation independent from corrupt execution data", () => {
  const value = JSON.stringify({
    folderId: "folder",
    reviewId: "review",
    connectionId: "connection",
    provider: "unknown",
    instructions: 4,
  });
  expect(() => readRunPayload(value)).toThrow();
  for (const field of ["folderId", "reviewId", "connectionId"] as const) {
    expect(readRunPayload(value, "throw", field)).toEqual({
      [field]: JSON.parse(value)[field],
    });
    expect(() =>
      readRunPayload(JSON.stringify({ [field]: 4 }), "throw", field),
    ).toThrow();
    expect(readRunPayload("{}", "throw", field)).toEqual({});
  }
});
it("rejects undeclared writer fields at compile and runtime boundaries", () => {
  // @ts-expect-error Undeclared fields cannot enter a typed writer.
  expect(() => writeRunPayload({ temId: "team" })).toThrow();
});
