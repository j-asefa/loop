import { expect, it } from "vitest";
import { inspectPiAuth } from "../src/native-auth/pi-status";
import type { AuthDriver, AuthOptions } from "../src/server/native-auth";

const options = {
  executable: "/runner/pi",
  project: "/project",
  env: { HOME: "/runner/home", PI_CODING_AGENT_DIR: "/runner/pi-home" },
};
it("checks fresh native Pi auth, projects IDs only and never claims subscription", async () => {
  let configured = true;
  let disposed = 0;
  const seen: AuthOptions[] = [];
  const factory = async (input: AuthOptions): Promise<AuthDriver> => {
    seen.push(input);
    return {
      providers: async () => [
        {
          id: "provider",
          name: "Provider",
          configured,
          methods: [],
          secret: "never returned",
        },
      ],
      login: async () => {
        throw new Error("must not log in");
      },
      dispose: async () => {
        disposed++;
      },
    };
  };
  expect(await inspectPiAuth(options, factory)).toEqual({
    authenticated: true,
    authMethod: "existing",
    providers: ["provider"],
  });
  configured = false;
  expect(await inspectPiAuth(options, factory)).toEqual({
    authenticated: false,
    authMethod: "existing",
    providers: [],
  });
  expect(seen).toEqual([
    { ...options, name: "pi" },
    { ...options, name: "pi" },
  ]);
  expect(disposed).toBe(2);
});
it.each(["invalid", "dead", "failure"])(
  "refuses %s status and disposes the native process",
  async (mode) => {
    let disposed = false;
    await expect(
      inspectPiAuth(options, async () => ({
        dead: mode === "dead",
        providers: async () => {
          if (mode === "failure") throw new Error("sensitive upstream output");
          return [
            {
              id: "provider",
              name: "Provider",
              configured: mode === "invalid" ? ("yes" as any) : true,
              methods: [],
            },
          ];
        },
        login: async () => {},
        dispose: async () => {
          disposed = true;
        },
      })),
    ).rejects.toThrow("Pi account status could not be checked");
    expect(disposed).toBe(true);
  },
);
it("refuses relative executable paths before spawning", async () => {
  await expect(
    inspectPiAuth({ ...options, executable: "pi" }, async () => {
      throw new Error("spawned");
    }),
  ).rejects.toThrow("host-resolved");
});

it("filters ambient credentials and injection before creating the native driver", async () => {
  const env = { HOME: "/runner", PI_CODING_AGENT_DIR: "/runner/pi", OPENAI_API_KEY: "fixture", NODE_OPTIONS: "--import injected", LOOP_SESSION_TOKEN: "fixture" };
  await inspectPiAuth({ ...options, env }, async (input) => {
    expect(input.env).toEqual({ HOME: "/runner", PI_CODING_AGENT_DIR: "/runner/pi" });
    return { providers: async () => [], models: async () => [], login: async () => {}, dispose: async () => {} };
  });
  expect(env.OPENAI_API_KEY).toBe("fixture");
});
