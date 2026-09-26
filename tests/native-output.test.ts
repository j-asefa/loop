import { expect, it } from "vitest";
import { NativeOutput, NATIVE_OUTPUT_BYTES } from "../src/server/native-output";

it("bounds aggregate UTF-8 output and preserves the last accepted projection", () => {
  const output = new NativeOutput();
  for (let i = 0; i < 100; i++) {
    const item = {
      id: String(i),
      kind: "assistant" as const,
      text: "😀".repeat(16000),
    };
    const before = output.bytes;
    if (!output.set(item.id, item)) {
      expect(output.bytes).toBe(before);
      expect(output.get(item.id)).toBeUndefined();
      expect(before + Buffer.byteLength(JSON.stringify(item))).toBeGreaterThan(
        NATIVE_OUTPUT_BYTES,
      );
      expect(output.bytes).toBeLessThanOrEqual(NATIVE_OUTPUT_BYTES);
      return;
    }
  }
  throw new Error("Aggregate budget did not reject output");
});
it("accounts for replacements and tracks only changed items across flushes", () => {
  const output = new NativeOutput();
  output.set("a", { id: "a", kind: "assistant", text: "first" });
  output.set("b", { id: "b", kind: "tool", text: "second" });
  output.dirty.clear();
  output.set("b", { id: "b", kind: "tool", text: "updated" });
  expect([...output.dirty]).toEqual(["b"]);
  expect(output.bytes).toBe(
    [...output.values()].reduce(
      (n, item) => n + Buffer.byteLength(JSON.stringify(item)),
      0,
    ),
  );
  const previous = output.get("b");
  expect(
    output.set("b", {
      id: "b",
      kind: "tool",
      text: "x".repeat(NATIVE_OUTPUT_BYTES),
    }),
  ).toBe(false);
  expect(output.get("b")).toBe(previous);
  output.clear();
  expect(output.bytes).toBe(0);
  expect([...output.values()]).toEqual([]);
  expect(output.dirty.size).toBe(0);
});

it("keeps a bounded recent replay window without rejecting valid history", () => {
  const output = new NativeOutput();
  for (let i = 0; i < 100; i++)
    expect(
      output.replay({
        id: String(i),
        kind: "assistant",
        text: "é".repeat(32000),
      }),
    ).toBe(true);
  expect(output.bytes).toBeLessThanOrEqual(NATIVE_OUTPUT_BYTES);
  expect(output.get("0")).toBeUndefined();
  expect(output.get("99")).toBeDefined();
});
