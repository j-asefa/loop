import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentAppearance } from "../src/client/agentAppearance";

const publicDirectory = new URL("../public/", import.meta.url);
const robotDirectory = new URL("avatars/robots/", publicDirectory);
const names = readdirSync(robotDirectory)
  .filter((file) => file.endsWith(".webp"))
  .map((file) => file.slice(0, -5));
const covers = new Set([
  ...readdirSync(new URL("profile-covers/", publicDirectory))
    .filter((file) => file.endsWith(".webp"))
    .map((file) => `/profile-covers/${file}`),
]);

describe("agent appearance", () => {
  it("ships 100 distinct robot avatars and retires the old artwork", () => {
    expect(names).toHaveLength(100);
    expect(
      readdirSync(new URL("avatars/", publicDirectory)).filter((file) =>
        file.endsWith(".webp"),
      ),
    ).toHaveLength(0);
    const artwork = names.map((name) =>
      createHash("sha256")
        .update(readFileSync(new URL(`${name}.webp`, robotDirectory)))
        .digest("hex"),
    );
    expect(new Set(artwork).size).toBe(100);
  });

  it("gives every named character a distinct, shipped cover", () => {
    expect(names).toHaveLength(100);
    const namedCovers = new Set<string>();
    for (const name of names) {
      const appearance = agentAppearance(name);
      expect(appearance.character).toBe(name);
      expect(covers.has(appearance.cover)).toBe(true);
      expect(agentAppearance(name.toUpperCase())).toEqual(appearance);
      namedCovers.add(appearance.cover);
    }
    expect(namedCovers.size).toBe(100);
  });

  it("makes all 100 covers reachable and varies covers for shared avatars", () => {
    expect(covers.size).toBe(100);
    const selected = new Set<string>();
    const perAvatar = new Map<string, Set<string>>();
    for (let index = 0; index < 10000; index++) {
      const appearance = agentAppearance(`profile-${index}`);
      selected.add(appearance.cover);
      const variants = perAvatar.get(appearance.character) ?? new Set<string>();
      variants.add(appearance.cover);
      perAvatar.set(appearance.character, variants);
    }
    expect(selected).toEqual(covers);
    expect(perAvatar.size).toBe(100);
    for (const variants of perAvatar.values()) {
      expect(variants.size).toBeGreaterThan(1);
    }
    for (const name of ["", "../outside", "constructor", "a/b?c", "Agent 🚀"]) {
      expect(covers.has(agentAppearance(name).cover)).toBe(true);
    }
  });
});
