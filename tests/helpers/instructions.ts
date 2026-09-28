// The API runtime appends Loop's plan guidance (PLAN_GUIDANCE in
// src/server/native-tools.ts) after an agent's own instructions whenever
// loop_plan is advertised. Fixture providers that route on an agent's
// instructions compare only the agent-authored part.
export const ownInstructions = (instructions = "") =>
  instructions.replace(/(?:\n\n)?Loop plans: [\s\S]*$/, "");
