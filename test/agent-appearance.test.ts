import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentAppearance } from "../src/client/agentAppearance";

const publicDirectory = new URL("../public/", import.meta.url);
const names = readdirSync(new URL("avatars/", publicDirectory))
  .filter((file) => file.endsWith(".webp"))
  .map((file) => file.slice(0, -5));
const covers = new Set([
  "/profile-cover.webp",
  ...readdirSync(new URL("profile-covers/", publicDirectory))
    .filter((file) => file.endsWith(".webp"))
    .map((file) => `/profile-covers/${file}`),
]);

describe("agent appearance", () => {
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

  it("makes all 112 covers reachable and varies covers for shared avatars", () => {
    expect(covers.size).toBe(112);
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

  it("preserves existing avatar assignments and the original twelve covers", () => {
    const originals = [
      "atlas",
      "nova",
      "sage",
      "echo",
      "orbit",
      "moss",
      "ember",
      "cobalt",
      "owl",
      "prism",
      "pebble",
      "flint",
    ];
    for (const name of originals) {
      expect(agentAppearance(name).cover).toBe(
        name === "atlas"
          ? "/profile-cover.webp"
          : `/profile-covers/${name}.webp`,
      );
    }
    for (const [name, character, background] of [
      ["Loop", "archer", "#c6ad92"],
      ["code-reviewer", "horizon", "#d8b544"],
      ["research-assistant", "blossom", "#b8adb7"],
      ["planner", "mercury", "#c6ad92"],
      ["", "ocean", "#a6b9b8"],
    ]) {
      expect(agentAppearance(name)).toMatchObject({ character, background });
    }
  });
});
