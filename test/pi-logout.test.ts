import { expect, it } from "vitest";
import { logoutPi } from "../src/native-auth/pi-status";
const options = { executable: "/runner/pi", project: "/project", env: { HOME: "/runner", OPENAI_API_KEY: "fixture" } };
it("signs out configured providers sequentially through the native API", async () => {
  const calls: string[] = [];
  await logoutPi(options, async (input) => {
    expect(input.env).toEqual({ HOME: "/runner" });
    return {
      providers: async () => [
        { id: "a", name: "A", configured: true, methods: [] },
        { id: "b", name: "B", configured: false, methods: [] },
        { id: "c", name: "C", configured: true, methods: [] },
      ],
      logout: async (id) => { calls.push(id); },
      login: async () => { throw new Error("not login"); },
      dispose: async () => { calls.push("disposed"); },
    };
  });
  expect(calls).toEqual(["a", "c", "disposed"]);
});
it.each(["missing", "dead", "failure"])("sanitizes %s and always disposes", async (mode) => {
  let disposed = false;
  await expect(logoutPi(options, async () => ({
    dead: mode === "dead",
    providers: async () => [{ id: "a", name: "A", configured: true, methods: [] }],
    logout: mode === "missing" ? undefined : async () => { throw new Error("secret upstream error"); },
    login: async () => {}, dispose: async () => { disposed = true; },
  }))).rejects.toThrow("Pi sign-out could not be completed");
  expect(disposed).toBe(true);
});
