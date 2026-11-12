import { describe, expect, it } from "vitest";
import { PublicRun } from "../src/shared/workspace-contract-schemas.js";

// The public run is keyed on `state` (D2/D3): a field a state's writers never
// set is absent from its arm. Non-strict arms strip such stray keys, and an
// arm that requires a lease field rejects a row without it.
const base = {
  id: "r1",
  owner_id: "owner",
  agent_id: null,
  conversation_id: null,
  kind: "agent",
  input: "input",
  idempotency_key: "k",
  payload: "{}",
  created_at: 1,
  updated_at: 1,
  active_ms: 0,
};

function run(state: string, extra: Record<string, unknown> = {}) {
  return PublicRun.safeParse({ ...base, state, ...extra });
}

describe("PublicRun arms", () => {
  it("parses every state from its base shape", () => {
    for (const state of [
      "queued",
      "waiting_children",
      "running",
      "pausing",
      "paused",
      "awaiting_approval",
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ]) {
      const extra =
        state === "awaiting_approval"
          ? { worker_id: "w" }
          : state === "running" || state === "pausing"
            ? { worker_id: "w", heartbeat: 2, active_since: 1 }
            : state === "paused"
              ? { result: null }
              : { result: null, worker_id: "w", heartbeat: 2 };
      expect(run(state, extra).success, state).toBe(true);
    }
  });

  it("strips fields queued never carries", () => {
    const parsed = run("queued", {
      result: null,
      error: null,
      worker_id: "w",
    });
    expect(parsed.success).toBe(true);
    const data = parsed.data;
    expect(data.result).toBeUndefined();
    expect(data.error).toBeUndefined();
    expect(data.worker_id).toBeUndefined();
  });

  it("strips queue and preview fields completed never carries", () => {
    const parsed = run("completed", {
      result: "ok",
      queue_rank: 1,
      queue_position: 2,
      preview: "p",
      preview_artifact: null,
      active_since: 5,
      attention_dismissed_at: 6,
    });
    expect(parsed.success).toBe(true);
    const data = parsed.data;
    expect(data.queue_rank).toBeUndefined();
    expect(data.queue_position).toBeUndefined();
    expect(data.preview).toBeUndefined();
    expect(data.preview_artifact).toBeUndefined();
    expect(data.active_since).toBeUndefined();
    expect(data.attention_dismissed_at).toBeUndefined();
    expect(data.error).toBeUndefined();
  });

  it("keeps the lease fields where running carries them", () => {
    const parsed = run("running", {
      worker_id: "w",
      heartbeat: 2,
      active_since: 3,
    });
    expect(parsed.success).toBe(true);
    const data = parsed.data;
    expect(data.worker_id).toBe("w");
    expect(data.heartbeat).toBe(2);
    expect(data.active_since).toBe(3);
  });

  it("keeps queue fields only on queued", () => {
    const queued = run("queued", { queue_rank: 1, queue_position: 2 });
    expect(queued.success).toBe(true);
    expect(queued.data.queue_rank).toBe(1);
    expect(queued.data.queue_position).toBe(2);
    const running = run("running", { queue_rank: 1 });
    expect(running.success).toBe(true);
    expect(running.data.queue_rank).toBeUndefined();
  });

  it("requires the lease on awaiting_approval", () => {
    const missing = run("awaiting_approval", { heartbeat: 2 });
    expect(missing.success).toBe(false);
    const kept = run("awaiting_approval", { worker_id: "w", heartbeat: 2 });
    expect(kept.success).toBe(true);
  });

  it("strips preview from cancelled but keeps it on attention-reachable states", () => {
    const cancelled = run("cancelled", { error: "e", preview: "p" });
    expect(cancelled.success).toBe(true);
    expect(cancelled.data.preview).toBeUndefined();
    for (const state of ["failed", "interrupted"]) {
      const parsed = run(state, { error: "e", preview: "p" });
      expect(parsed.success, state).toBe(true);
      expect(parsed.data.preview, state).toBe("p");
    }
  });

  it("rejects an unknown state", () => {
    expect(run("dispatched").success).toBe(false);
  });
});
