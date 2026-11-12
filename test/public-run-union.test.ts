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

function arm(state: string, extra: Record<string, unknown> = {}) {
  const parsed = run(state, extra);
  if (!parsed.success) throw new Error(`expected ${state} to parse`);
  return parsed.data;
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
    if (!parsed.success) throw new Error("expected queued to parse");
    const data = parsed.data;
    if (data.state !== "queued") throw new Error("expected the queued arm");
    expect("result" in data).toBe(false);
    expect("error" in data).toBe(false);
    expect("worker_id" in data).toBe(false);
  });

  it("strips queue and preview fields completed never carries", () => {
    const data = arm("completed", {
      result: "ok",
      queue_rank: 1,
      queue_position: 2,
      preview: "p",
      preview_artifact: null,
      active_since: 5,
      attention_dismissed_at: 6,
      error: "e",
    });
    if (data.state !== "completed") throw new Error("expected completed arm");
    expect("queue_rank" in data).toBe(false);
    expect("queue_position" in data).toBe(false);
    expect("preview" in data).toBe(false);
    expect("preview_artifact" in data).toBe(false);
    expect("active_since" in data).toBe(false);
    expect("attention_dismissed_at" in data).toBe(false);
    expect("error" in data).toBe(false);
    expect(data.result).toBe("ok");
  });

  it("keeps the lease fields where running carries them", () => {
    const data = arm("running", {
      worker_id: "w",
      heartbeat: 2,
      active_since: 3,
    });
    if (data.state !== "running") throw new Error("expected running arm");
    expect(data.worker_id).toBe("w");
    expect(data.heartbeat).toBe(2);
    expect(data.active_since).toBe(3);
  });

  it("keeps queue fields only on queued", () => {
    const queued = arm("queued", { queue_rank: 1, queue_position: 2 });
    if (queued.state !== "queued") throw new Error("expected queued arm");
    expect(queued.queue_rank).toBe(1);
    expect(queued.queue_position).toBe(2);
    const running = arm("running", { queue_rank: 1 });
    if (running.state !== "running") throw new Error("expected running arm");
    expect("queue_rank" in running).toBe(false);
  });

  it("requires the lease on awaiting_approval", () => {
    const missing = run("awaiting_approval", { heartbeat: 2 });
    expect(missing.success).toBe(false);
    const kept = arm("awaiting_approval", { worker_id: "w", heartbeat: 2 });
    if (kept.state !== "awaiting_approval")
      throw new Error("expected awaiting_approval arm");
    expect(kept.worker_id).toBe("w");
  });

  it("strips preview from cancelled but keeps it on attention-reachable states", () => {
    const cancelled = arm("cancelled", { error: "e", preview: "p" });
    if (cancelled.state !== "cancelled")
      throw new Error("expected cancelled arm");
    expect("preview" in cancelled).toBe(false);
    for (const state of ["failed", "interrupted"] as const) {
      const data = arm(state, { error: "e", preview: "p" });
      if (data.state !== state) throw new Error(`expected ${state} arm`);
      expect(data.preview).toBe("p");
    }
  });

  it("rejects an unknown state", () => {
    expect(run("dispatched").success).toBe(false);
  });
});
