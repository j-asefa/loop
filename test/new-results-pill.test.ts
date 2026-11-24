import { describe, expect, it } from "vitest";
import { newRowsAtTop } from "../src/client/useNewResultsPill";

describe("newRowsAtTop", () => {
  it("counts rows that now lead the list", () => {
    expect(newRowsAtTop(new Set(["a", "b"]), ["c", "d", "a", "b"])).toBe(2);
    expect(newRowsAtTop(new Set(["a", "b"]), ["a", "b", "c"])).toBe(0);
  });

  it("ignores reordering below the top and a wholly different list", () => {
    expect(newRowsAtTop(new Set(["a", "b", "c"]), ["a", "c", "b"])).toBe(0);
    expect(newRowsAtTop(new Set(["a", "b"]), ["x", "y"])).toBe(0);
    expect(newRowsAtTop(new Set(["a"]), [])).toBe(0);
  });
});
