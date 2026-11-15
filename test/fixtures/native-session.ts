import { capabilities, type Adapter } from "../../src/adapters/types.js";
import type { Binding } from "../../src/server/native/state.js";

/** Small adapters for boundary fixtures; unexpected IO fails the fixture. */
export function fixtureAdapter(overrides: Partial<Adapter>): Adapter {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected fixture adapter IO");
  };
  return {
    capabilities,
    start: unexpected,
    prompt: unexpected,
    answer: unexpected,
    cancel: unexpected,
    dispose: unexpected,
    ...overrides,
  };
}
export function fixtureBinding(
  binding: Pick<Binding, "conversation_id" | "generation" | "harness"> &
    Partial<Binding>,
): Binding {
  return {
    worktree_source: null,
    worktree_agent_id: "fixture-agent",
    native_id: null,
    project: process.cwd(),
    model: null,
    instructions: "",
    state: "idle",
    ...binding,
  };
}
