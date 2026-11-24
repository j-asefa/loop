import { describe, expect, it } from "vitest";
import { IdentityCache, sameValue } from "../src/client/stableIdentity";

const card = (id: string, title: string, extra: object = {}) => ({
  id,
  title,
  last_message: { id: id + "-m", role: "assistant", content: "Done." },
  tags: ["a", "b"],
  ...extra,
});

describe("sameValue", () => {
  it("compares JSON-like data by content", () => {
    expect(sameValue(card("1", "x"), card("1", "x"))).toBe(true);
    expect(sameValue(card("1", "x"), card("1", "y"))).toBe(false);
    expect(sameValue([1, { a: [2] }], [1, { a: [2] }])).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });

  it("treats an undefined property as missing, as JSON does", () => {
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });

  it("compares functions and class instances by identity only", () => {
    const f = () => {};
    expect(sameValue({ f }, { f })).toBe(true);
    expect(sameValue({ f }, { f: () => {} })).toBe(false);
    expect(sameValue(new Date(0), new Date(0))).toBe(false);
  });
});

describe("IdentityCache", () => {
  it("keeps the previous object while its content is unchanged", () => {
    const cache = new IdentityCache();
    const first = card("1", "Review #42");
    expect(cache.keep("1", first)).toBe(first);
    cache.sweep();
    // A refresh rebuilds an equal object: the card keeps the old reference.
    expect(cache.keep("1", card("1", "Review #42"))).toBe(first);
  });

  it("returns the new object when the content changed", () => {
    const cache = new IdentityCache();
    cache.keep("1", card("1", "Review #42"));
    cache.sweep();
    const changed = card("1", "Review #42", { unread: true });
    expect(cache.keep("1", changed)).toBe(changed);
    cache.sweep();
    // The changed object is now the one kept.
    expect(cache.keep("1", card("1", "Review #42", { unread: true }))).toBe(
      changed,
    );
  });

  it("keeps each item's identity when the list is reordered", () => {
    const cache = new IdentityCache();
    const a = card("a", "A"),
      b = card("b", "B"),
      c = card("c", "C");
    for (const item of [a, b, c]) cache.keep(item.id, item);
    cache.sweep();
    const reordered = [card("c", "C"), card("a", "A"), card("b", "B")].map(
      (item) => cache.keep(item.id, item),
    );
    expect(reordered).toEqual([c, a, b]);
    expect(reordered[0]).toBe(c);
    expect(reordered[1]).toBe(a);
    expect(reordered[2]).toBe(b);
  });

  it("forgets removed items at the next sweep", () => {
    const cache = new IdentityCache();
    const a = card("a", "A");
    cache.keep("a", a);
    cache.keep("b", card("b", "B"));
    cache.sweep();
    cache.keep("a", card("a", "A"));
    cache.sweep();
    expect(cache.size).toBe(1);
    // A removed item that returns is new, not a stale copy.
    const back = card("b", "B");
    expect(cache.keep("b", back)).toBe(back);
  });

  it("passes undefined through without keeping it", () => {
    const cache = new IdentityCache();
    expect(cache.keep("agent", undefined)).toBeUndefined();
    const agent = { id: "g", name: "orion" };
    expect(cache.keep("agent", agent)).toBe(agent);
    expect(cache.keep("agent", undefined)).toBeUndefined();
    const again = { id: "g", name: "orion" };
    expect(cache.keep("agent", again)).toBe(again);
  });
});
