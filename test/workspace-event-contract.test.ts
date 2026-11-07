import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmittedWorkspaceEvent,
  WorkspaceEvent,
  historicalEvent,
  invalidate,
  parseEmission,
  type WorkspaceEmission,
} from "../src/shared/workspace-events";

const decision = {
  decisionId: "decision",
  conversationId: "thread",
  runId: "run",
  generation: "generation",
  nativeId: "adapter-request",
  request: {},
};
const examples = [
  ["reverse.settled", { callId: "call" }],
  ["queued", {}],
  ["running", { resumed: true }],
  ["pausing", {}],
  ["paused", { message: "Paused" }],
  ["awaiting_approval", { approvalId: "approval" }],
  ["completed", { preview: true }],
  ["failed", { reason: "Rejected" }],
  ["cancelled", {}],
  ["interrupted", { native: true }],
  ["waiting_children", {}],
  ["progress", { message: "Working" }],
  ["run.failed", { message: "Failed", phase: "provider response" }],
  [
    "agent_mail.sent",
    { mailId: "mail", threadId: "thread", delivery: "new_turn" },
  ],
  ["agent_mail.held", { mailId: "mail", threadId: "thread" }],
  ["import.progress", { completed: 1, total: 2 }],
  ["feed.changed", { artifactId: "artifact", hidden: true }],
  [
    "feed.card",
    {
      conversationId: "thread",
      cardKey: "run:run",
      kind: "thread",
      removed: false,
      card: { title: "Live work" },
    },
  ],
  ["approval.auto_approved", { approvalId: "approval" }],
  [
    "approval.requested",
    { approvalId: "approval", request: { title: "Run?" } },
  ],
  [
    "approval.decided",
    { approvalId: "approval", decision: "approve", origin: "loop" },
  ],
  ["tool.failed", { tool: "read", artifactId: "artifact" }],
  ["tool.completed", { tool: "read", artifactId: "" }],
  ["artifact.published", { artifactId: "artifact" }],
  ["activity.updated", { key: "plan:native:1", kind: "plan", sequence: 1 }],
  ["steering.pending", { messageId: "message", steeringId: "steer" }],
  ["steering.delivered", { messageId: "message" }],
  ["steering.failed", { messageId: "message" }],
  [
    "message.started",
    { messageId: "message", round: 0, snapshot: { model: "fixture" } },
  ],
  ["message.delta", { messageId: "message", text: "Hello" }],
  ["message.completed", { messageId: "message" }],
  [
    "message.upsert",
    {
      message: {
        id: "message",
        owner_id: "owner",
        conversation_id: "thread",
        run_id: "run",
        role: "assistant",
        content: "Hello",
        metadata: "{}",
        created_at: 1,
        revision: 1,
        cursor: [1, 1, 1],
      },
    },
  ],
  [
    "message.delta",
    {
      messageId: "message",
      conversationId: "thread",
      baseRevision: 1,
      revision: 2,
      offset: 5,
      chunkIndex: 0,
      text: " world",
    },
  ],
  [
    "message.remove",
    { messageId: "message", conversationId: "thread", revision: 3 },
  ],
  ["decision.pending", { ...decision, state: "pending" }],
  ["decision.deciding", { ...decision, state: "deciding" }],
  ["decision.resolved", { ...decision, state: "resolved" }],
  ["decision.expired", { ...decision, state: "expired" }],
  ["decision.unknown", { ...decision, state: "unknown" }],
  ["decision.remove", { ...decision, state: "unknown" }],
  ["trace.updated", { round: 0 }],
  ["provider.receipt", { externalId: "provider", usage: { input_tokens: 1 } }],
  ["attention.dismissed", {}],
  ["queue.reordered", { direction: "up" }],
  ["queue.edited", {}],
  ["native.usage", { usage: { input_tokens: 1, output_tokens: 2 } }],
  [
    "native.event",
    {
      conversationId: "thread",
      generation: "generation",
      event: { type: "delta", id: "message", text: "Hello" },
    },
  ],
  [
    "native.event",
    {
      conversationId: "thread",
      generation: "generation",
      event: {
        type: "request",
        request: {
          id: "request",
          kind: "approval",
          title: "Complete MCP request in your browser",
          detail: "Reconnect Linear.",
          completionUrl: "https://chatgpt.com/apps/linear/example",
          choices: ["accept", "decline", "cancel"],
        },
      },
    },
  ],
] satisfies WorkspaceEmission[];

it("round-trips every declared producer type through emit, durable v2 rows and the v3 union", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-event-contract-"));
  vi.resetModules();
  vi.stubEnv("LOOP_DATA_DIR", dir);
  const { db, changes, emit } = await import("../src/server/db");
  try {
    db.prepare(
      "INSERT INTO runs(id,owner_id,input,state,idempotency_key,created_at,updated_at) VALUES('run','owner','fixture','running','key',1,1)",
    ).run();
    expect([...new Set(examples.map(([type]) => type))].sort()).toEqual(
      EmittedWorkspaceEvent.options
        .map((option) => option.shape.type.value)
        .filter((type) => type !== "connection.status")
        .sort(),
    );
    for (const emission of examples) {
      const id = emit("owner", "run", ...emission);
      const row = db
        .prepare("SELECT run_id,type,payload FROM events WHERE id=?")
        .get(id) as { run_id: string; type: string; payload: string };
      expect(row.payload).toBe(JSON.stringify(emission[1]));
      const event = historicalEvent(row);
      expect(event).toEqual({
        type: emission[0],
        payload: emission[1],
        scope: emission[0].startsWith("decision.")
          ? { kind: "collection", id: "decisions" }
          : ["message.upsert", "message.remove"].includes(emission[0]) ||
              (emission[0] === "message.delta" && "revision" in emission[1])
            ? { kind: "conversation", id: "thread" }
            : { kind: "run", id: "run" },
        subject: { kind: "run", id: "run" },
      });
      expect(WorkspaceEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(
        event,
      );
    }
    const before = db.prepare("SELECT count(*) n FROM events").get();
    expect(() => {
      // @ts-expect-error unknown producer names cannot enter the durable log
      emit("owner", "run", "future.unknown", {});
    }).toThrow();
    expect(() => {
      // @ts-expect-error payloads are correlated with the discriminant
      emit("owner", "run", "message.delta", { text: "missing identity" });
    }).toThrow();
    expect(() => {
      // @ts-expect-error strict variants reject undeclared payload keys
      emit("owner", "run", "queued", { unexpected: true });
    }).toThrow();
    expect(() =>
      emit("owner", "run", "progress", {
        message: "x".repeat(8 * 1024 * 1024 + 1),
      }),
    ).toThrow();
    expect(() =>
      emit("owner", "run", "native.event", {
        conversationId: "thread",
        generation: "generation",
        event: {
          type: "request",
          request: {
            id: "request",
            kind: "question",
            title: "Choose",
            detail: "é".repeat(32000),
          },
        },
      }),
    ).toThrow("Native request exceeds its ingress byte budget");
    expect(() =>
      emit("owner", "run", "native.event", {
        conversationId: "thread",
        generation: "generation",
        event: {
          type: "status",
          status: "running",
          detail: "é".repeat(128000),
        },
      }),
    ).toThrow("Native event exceeds its ingress byte budget");
    expect(db.prepare("SELECT count(*) n FROM events").get()).toEqual(before);
  } finally {
    changes.close();
    db.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reconciles malformed historical rows and unknown future events without inventing projection data", () => {
  for (const [type, payload] of [
    ["old.unknown", "{}"],
    ["message.delta", "{bad json"],
    ["message.delta", '{"text":"no id"}'],
    ["queued", '{"extra":true}'],
    ["native.usage", '{"usage":{"input_tokens":-1,"output_tokens":2}}'],
  ])
    expect(historicalEvent({ run_id: "run", type, payload })).toEqual(
      invalidate(),
    );
  expect(
    parseEmission("run", "approval.auto_approved", {
      decisionId: "decision",
      title: "Approved",
    }).type,
  ).toBe("approval.auto_approved");
  expect(
    parseEmission("run", "message.delta", {
      messageId: "message",
      native: true,
    }).type,
  ).toBe("message.delta");
  expect(() =>
    parseEmission("run", "provider.receipt", { usage: { tokens: NaN } }),
  ).toThrow();
});

it("checks producer ownership and accepts deletion evidence only for its original owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-event-ownership-"));
  vi.resetModules();
  vi.stubEnv("LOOP_DATA_DIR", dir);
  const { db, changes, deadlines, emit, ownedEventSubject } =
    await import("../src/server/db");
  try {
    db.exec(
      "INSERT INTO artifacts(id,owner_id,title,kind,content,created_at,updated_at) VALUES('artifact','alice','A','markdown','Body',1,1)",
    );
    const count = () => db.prepare("SELECT count(*) n FROM events").get();
    const before = count();
    expect(() =>
      emit("bob", { kind: "artifact", id: "artifact" }, "invalidate", {
        scope: { kind: "collection", id: "saved" },
      }),
    ).toThrow(/not owned/);
    expect(count()).toEqual(before);
    const proof = ownedEventSubject("alice", {
      kind: "artifact",
      id: "artifact",
    });
    db.transaction(() => {
      db.exec("DELETE FROM artifacts WHERE id='artifact'");
      emit("alice", { kind: "collection", id: "saved" }, "tombstone", {
        scope: { kind: "collection", id: "saved" },
        removed: proof,
      });
    }).immediate();
    expect(() =>
      emit("bob", { kind: "collection", id: "saved" }, "tombstone", {
        scope: { kind: "collection", id: "saved" },
        removed: proof,
      }),
    ).toThrow(/another owner/);
    expect(() =>
      emit("alice", { kind: "collection", id: "saved" }, "tombstone", {
        scope: { kind: "collection", id: "saved" },
        removed: { ...proof },
      }),
    ).toThrow(/not owned/);
    expect(
      db.prepare("SELECT run_id FROM events WHERE type='tombstone'").all(),
    ).toEqual([{ run_id: null }, { run_id: null }]);
  } finally {
    deadlines.close();
    changes.close();
    db.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("replays stored approval decisions without losing their payload", () => {
  for (const origin of ["loop"]) {
    const payload = { approvalId: "approval", decision: "approve", origin };
    expect(
      historicalEvent({
        run_id: "run",
        type: "approval.decided",
        payload: JSON.stringify(payload),
      }),
    ).toMatchObject({ type: "approval.decided", payload });
  }
});
