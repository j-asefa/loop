import { expect, it } from "vitest";
import { runtimeAuthScope } from "../src/shared/runtime-auth-scope";

it("isolates authentication evidence across backend, runner and generation changes", () => {
  const runtime = { name: "codex", backend: "hapi" as const, environmentId: "local", generation: 1 };
  const scope = runtimeAuthScope(runtime);
  const states = { [scope]: "complete" };
  expect(states[runtimeAuthScope({ ...runtime })]).toBe("complete");
  for (const changed of [
    { name: "codex" },
    { ...runtime, environmentId: "replacement" },
    { ...runtime, generation: 2 },
    { ...runtime, name: "pi" },
  ]) expect(states[runtimeAuthScope(changed)]).toBeUndefined();
});
