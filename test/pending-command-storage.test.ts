import { expect, it } from "vitest";
import { memoryCommands } from "../src/client/pendingCommandStorage";
import { integrationTokenRequest } from "../src/shared/card-access";

it("recovers a token receipt only in its owner/source slot without touching browser storage", () => {
  const denied = {
    configurable: true,
    get() {
      throw new Error("Persistent storage is forbidden");
    },
  };
  const originals = ["localStorage", "sessionStorage"].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name] of originals)
    Object.defineProperty(globalThis, name, denied);
  try {
    const commands =
      memoryCommands<ReturnType<typeof integrationTokenRequest>>();
    const receipt = integrationTokenRequest("Test", ["read"]);
    commands("alice", "", ["token"]).write(receipt);
    expect(commands("alice", "", ["token"]).read()).toBe(receipt);
    expect(commands("bob", "", ["token"]).read()).toBeUndefined();
    expect(commands("alice", "remote", ["token"]).read()).toBeUndefined();
    expect(commands("alice", "", ["another"]).read()).toBeUndefined();
    commands("alice", "remote", ["token"]).remove();
    expect(commands("alice", "", ["token"]).read()).toBe(receipt);
    commands("alice", "", ["token"]).remove();
    expect(commands("alice", "", ["token"]).read()).toBeUndefined();
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
