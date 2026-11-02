import { describe, expect, it } from "vitest";
import { fleetEventProjection } from "../src/shared/fleet-workspace-events.js";
import {
  COMPLETE_WORKSPACE_CAPABILITIES,
  WorkspaceEvent,
  type WorkspaceCollection,
} from "../src/shared/workspace-events.js";
import { WorkspaceSourceFrame } from "../src/shared/workspace-multiplex.js";
import {
  WorkspaceChangeQueue,
  workspaceChangeAffects,
} from "../src/client/workspace-changes.js";

describe("fleet event projection", () => {
  it("keeps unopened transcript contents out of the shared stream while retaining invalidation", () => {
    const event = WorkspaceEvent.parse({
      type: "message.delta",
      scope: { kind: "conversation", id: "private-thread" },
      payload: { messageId: "message", text: "Private transcript fixture" },
    });
    expect(
      fleetEventProjection(event, {
        conversations: ["other-thread"],
        runs: [],
      }),
    ).toEqual({
      type: "invalidate",
      scope: { kind: "conversation", id: "private-thread" },
    });
    expect(
      fleetEventProjection(event, {
        conversations: ["private-thread"],
        runs: [],
      }),
    ).toEqual(event);
  });

  it("keeps trace details scoped without suppressing summary invalidation", () => {
    const trace = WorkspaceEvent.parse({
      type: "trace.updated",
      scope: { kind: "run", id: "selected-run" },
      payload: { round: 4 },
    });
    expect(
      fleetEventProjection(trace, { conversations: [], runs: [] }),
    ).toEqual({
      type: "invalidate",
      scope: trace.scope,
      scopes: [{ kind: "collection", id: "activities" }],
    });
    expect(
      fleetEventProjection(trace, {
        conversations: [],
        runs: ["selected-run"],
      }),
    ).toEqual(trace);
    const summary = WorkspaceEvent.parse({
      type: "invalidate",
      scope: { kind: "collection", id: "feed" },
    });
    expect(
      fleetEventProjection(summary, { conversations: [], runs: [] }),
    ).toEqual(summary);
  });

  it("does not send legacy transcript chunks for a selected run without an opened conversation", () => {
    const event = WorkspaceEvent.parse({
      type: "message.delta",
      scope: { kind: "run", id: "selected-run" },
      payload: { messageId: "legacy-message", text: "Private transcript" },
    });
    expect(
      fleetEventProjection(event, {
        conversations: [],
        runs: ["selected-run"],
      }),
    ).toEqual({ type: "invalidate", scope: event.scope });
  });

  it.each(["run", "conversation"] as const)(
    "uses the native transcript conversation identity rather than a selected %s scope",
    (kind) => {
      const event = WorkspaceEvent.parse({
        type: "native.event",
        scope: { kind, id: "selected-other-detail" },
        payload: {
          conversationId: "native-conversation",
          generation: "generation",
          event: { type: "delta", id: "message", text: "Private native text" },
        },
      });
      expect(
        fleetEventProjection(event, {
          conversations:
            kind === "conversation" ? ["selected-other-detail"] : [],
          runs: kind === "run" ? ["selected-other-detail"] : [],
        }),
      ).toEqual({ type: "invalidate", scope: event.scope });
      expect(
        fleetEventProjection(event, {
          conversations: ["native-conversation"],
          runs: [],
        }),
      ).toEqual(event);
    },
  );

  it.each([
    ["running", { message: "Started the authorized run" }],
    ["import.progress", { completed: 1, total: 2 }],
    [
      "approval.requested",
      { approvalId: "approval", request: { title: "Review this action" } },
    ],
  ] as const)(
    "retains the existing %s summary or decision contract without opened details",
    (type, payload) => {
      const event = WorkspaceEvent.parse({
        type,
        scope: { kind: "run", id: "unopened-run" },
        payload,
      });
      expect(
        fleetEventProjection(event, { conversations: [], runs: [] }),
      ).toEqual(event);
    },
  );

  it.each([
    ["trace.updated", { round: 4 }, "activities"],
    [
      "activity.updated",
      { key: "tool", kind: "tool", sequence: 1 },
      "activities",
    ],
    ["provider.receipt", { externalId: "private-receipt" }, "usage"],
    ["native.usage", { usage: { input_tokens: 2, output_tokens: 3 } }, "usage"],
  ] as const)(
    "refreshes the owning %s collection after filtering unopened detail",
    (type, payload, collection) => {
      const event = WorkspaceEvent.parse({
        type,
        scope: { kind: "run", id: "unopened-run" },
        payload,
      });
      const projected = fleetEventProjection(event, {
        conversations: [],
        runs: [],
      });
      expect(WorkspaceEvent.safeParse(projected).success).toBe(true);
      expect(projected).not.toHaveProperty("payload");
      const queue = new WorkspaceChangeQueue();
      queue.capabilities.set("peer:owner", COMPLETE_WORKSPACE_CAPABILITIES);
      queue.add("peer:owner", [projected]);
      const change = new CustomEvent("loop55-workspace-change", {
        detail: queue.drain(),
      });
      expect(workspaceChangeAffects(change, collection, "peer:owner")).toBe(
        true,
      );
      expect(workspaceChangeAffects(change, collection, "peer:other")).toBe(
        false,
      );
      expect(workspaceChangeAffects(change, "feed", "peer:owner")).toBe(false);
    },
  );

  it("retains secondary refresh scopes and subjects without retaining transcript content", () => {
    const event = WorkspaceEvent.parse({
      type: "message.delta",
      scope: { kind: "conversation", id: "private-thread" },
      subject: { kind: "message", id: "private-message" },
      scopes: [{ kind: "collection", id: "feed" }],
      payload: { messageId: "private-message", text: "Private transcript" },
    });
    const projected = fleetEventProjection(event, {
      conversations: [],
      runs: [],
    });
    expect(projected).toEqual({
      type: "invalidate",
      scope: event.scope,
      subject: event.subject,
      scopes: [{ kind: "collection", id: "feed" }],
    });
    const queue = new WorkspaceChangeQueue();
    queue.capabilities.set("peer:owner", COMPLETE_WORKSPACE_CAPABILITIES);
    queue.add("peer:owner", [projected]);
    expect(queue.drain().changes?.[0]?.events).toEqual([
      { type: "invalidate", scope: { kind: "collection", id: "feed" } },
    ]);
  });

  it.each(["conversation", "run"] as const)(
    "does not disclose unopened detail when a selected %s is only a secondary refresh scope",
    (kind) => {
      const event = WorkspaceEvent.parse({
        type: "trace.updated",
        scope: { kind: "run", id: "primary-run" },
        scopes: [{ kind, id: "selected-detail" }],
        payload: { round: 4 },
      });
      expect(
        fleetEventProjection(event, {
          conversations: kind === "conversation" ? ["selected-detail"] : [],
          runs: kind === "run" ? ["selected-detail"] : [],
        }),
      ).toEqual({
        type: "invalidate",
        scope: event.scope,
        scopes: [
          { kind, id: "selected-detail" },
          { kind: "collection", id: "activities" },
        ],
      });
    },
  );

  it("retains bounded collection refresh when all secondary scope slots are occupied", () => {
    const event = WorkspaceEvent.parse({
      type: "native.usage",
      scope: { kind: "run", id: "unopened-run" },
      subject: { kind: "run", id: "unopened-run" },
      scopes: Array.from({ length: 32 }, (_, index) => ({
        kind: "conversation",
        id: "unopened-" + index,
      })),
      payload: { usage: { input_tokens: 2, output_tokens: 3 } },
    });
    const projected = fleetEventProjection(event, {
      conversations: [],
      runs: [],
    });
    expect(WorkspaceEvent.safeParse(projected).success).toBe(true);
    expect(projected).not.toHaveProperty("payload");
    expect(projected.subject).toEqual(event.subject);
    const queue = new WorkspaceChangeQueue();
    queue.capabilities.set("peer:owner", COMPLETE_WORKSPACE_CAPABILITIES);
    queue.add("peer:owner", [projected]);
    expect(
      workspaceChangeAffects(
        new CustomEvent("loop55-workspace-change", { detail: queue.drain() }),
        "usage" satisfies WorkspaceCollection,
        "peer:owner",
      ),
    ).toBe(true);
  });

  it("reduces older untyped event frames to their invalidation cursor", () => {
    expect(
      WorkspaceSourceFrame.parse({
        v: 2,
        type: "events",
        epoch: "legacy-source",
        cursor: 9,
        events: [{ payload: "Unselected legacy transcript" }],
      }),
    ).toEqual({ v: 2, type: "events", epoch: "legacy-source", cursor: 9 });
  });
});
