import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAllAnimalSvgs } from "../scripts/generate-animal-avatars.mjs";
import { agentAppearance } from "../src/client/agentAppearance";

const publicDirectory = new URL("../public/", import.meta.url);
const animalDirectory = new URL("avatars/animals/", publicDirectory);
const names = readdirSync(animalDirectory)
  .filter((file) => file.endsWith(".svg"))
  .map((file) => file.slice(0, -4));
const coverSvg = (cover: string) => {
  expect(cover.startsWith("data:image/svg+xml,")).toBe(true);
  return decodeURIComponent(cover.slice("data:image/svg+xml,".length));
};
const colours = (svg: string) =>
  new Set(Array.from(svg.matchAll(/="(#[0-9a-f]{6})"/g), (match) => match[1]));

describe("agent appearance", () => {
  it("ships 100 distinct geometric animal SVG avatars and retires robot artwork", () => {
    expect(names).toHaveLength(100);
    expect(existsSync(new URL("avatars/robots/", publicDirectory))).toBe(false);
    expect(
      readdirSync(new URL("avatars/", publicDirectory)).filter((file) =>
        file.endsWith(".webp"),
      ),
    ).toHaveLength(0);
    const artwork = names.map((name) =>
      createHash("sha256")
        .update(readFileSync(new URL(`${name}.svg`, animalDirectory)))
        .digest("hex"),
    );
    expect(new Set(artwork).size).toBe(100);
  });

  it("draws the shipped avatars from the palettes the covers use", () => {
    const directory = mkdtempSync(join(tmpdir(), "loop-avatars-"));
    try {
      expect(buildAllAnimalSvgs(directory)).toBe(100);
      for (const name of names) {
        expect(readFileSync(join(directory, `${name}.svg`), "utf8")).toBe(
          readFileSync(new URL(`${name}.svg`, animalDirectory), "utf8"),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("draws every named character a distinct cover in its avatar's colours", () => {
    const namedCovers = new Set<string>();
    for (const name of names) {
      const appearance = agentAppearance(name);
      expect(appearance.character).toBe(name);
      expect(agentAppearance(name.toUpperCase())).toEqual(appearance);
      const avatar = readFileSync(
        new URL(`${name}.svg`, animalDirectory),
        "utf8",
      );
      const cover = coverSvg(appearance.cover);
      expect(cover).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" /);
      expect(cover).not.toMatch(/href|<script|<image/i);
      // Same sky as the avatar backdrop, drawn mostly in the avatar's colours.
      const background = /fill="(#[0-9a-f]{6})"/;
      expect(cover.match(background)?.[1]).toBe(avatar.match(background)?.[1]);
      const shared = [...colours(cover)].filter((colour) =>
        colours(avatar).has(colour),
      );
      expect(shared.length).toBeGreaterThanOrEqual(4);
      namedCovers.add(appearance.cover);
    }
    expect(namedCovers.size).toBe(100);
  });

  it("gives every other name the cover of its own avatar", () => {
    const named = new Map(
      names.map((name) => [name, agentAppearance(name).cover]),
    );
    const characters = new Set<string>();
    for (let index = 0; index < 10000; index++) {
      const appearance = agentAppearance(`profile-${index}`);
      expect(appearance.cover).toBe(named.get(appearance.character));
      characters.add(appearance.character);
    }
    expect(characters.size).toBe(100);
    for (const name of ["", "../outside", "constructor", "a/b?c", "Agent 🚀"]) {
      const appearance = agentAppearance(name);
      expect(appearance.cover).toBe(named.get(appearance.character));
    }
  });
});
