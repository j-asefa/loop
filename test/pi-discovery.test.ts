import { expect, it } from "vitest";
import { discoverPi } from "../src/native-auth/pi-status";
import type { AuthDriver } from "../src/server/native-auth";

const options = {
  executable: "/runner/pi",
  project: "/project",
  env: { HOME: "/runner" },
};
it("projects only configured native models, deduplicates and strips metadata", async () => {
  let disposed = false;
  const result = await discoverPi(options, async (input) => {
    expect(input).toEqual({ ...options, name: "pi" });
    return {
      providers: async () => [
        { id: "a", name: "A", configured: true, methods: [] },
        { id: "b", name: "B", configured: false, methods: [] },
      ],
      models: async () => [
        { provider: "a", id: "m", name: "Model", apiKey: "private" },
        { provider: "a", id: "m", name: "Model" },
        { provider: "b", id: "m" },
      ],
      login: async () => {
        throw new Error("must not log in");
      },
      dispose: async () => {
        disposed = true;
      },
    };
  });
  expect(result).toEqual({
    authenticated: true,
    authMethod: "existing",
    models: [{ id: "a/m", name: "Model" }],
  });
  expect(disposed).toBe(true);
});
it.each(["invalid", "dead", "missing", "error"])(
  "rejects %s discovery and disposes",
  async (mode) => {
    let disposed = false;
    await expect(
      discoverPi(options, async (): Promise<AuthDriver> => ({
        dead: mode === "dead",
        providers: async () => [],
        models:
          mode === "missing"
            ? undefined
            : async () => {
                if (mode === "error")
                  throw new Error("private upstream output");
                return mode === "invalid"
                  ? [{ provider: "bad/provider", id: "m" }]
                  : [];
              },
        login: async () => {},
        dispose: async () => {
          disposed = true;
        },
      })),
    ).rejects.toThrow("Pi models could not be checked");
    expect(disposed).toBe(true);
  },
);

it("filters ambient credentials and injection before creating the native driver", async () => {
  const env = { HOME: "/runner", PI_CODING_AGENT_DIR: "/runner/pi", OPENAI_API_KEY: "fixture", NODE_OPTIONS: "--import injected", LOOP_SESSION_TOKEN: "fixture" };
  await discoverPi({ ...options, env }, async (input) => {
    expect(input.env).toEqual({ HOME: "/runner", PI_CODING_AGENT_DIR: "/runner/pi" });
    return { providers: async () => [], models: async () => [], login: async () => {}, dispose: async () => {} };
  });
  expect(env.OPENAI_API_KEY).toBe("fixture");
});
