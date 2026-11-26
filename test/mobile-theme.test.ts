import { describe, expect, it } from "vitest";
import { DARK_THEME, LIGHT_THEME } from "../apps/mobile/src/theme.js";

function luminance(color: string): number {
  const components = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(color.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * components[0]! + 0.7152 * components[1]! + 0.0722 * components[2]!
  );
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("Expo color contrast", () => {
  it.each([
    ["light", LIGHT_THEME],
    ["dark", DARK_THEME],
  ] as const)("keeps both %s theme tab states readable", (_, theme) => {
    expect(contrast(theme.text, theme.tabBarBg)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(theme.tabBarActiveText, theme.tabBarActiveBg),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps dark theme text readable on the feed and sheet surfaces", () => {
    for (const surface of [
      DARK_THEME.bg,
      DARK_THEME.surface,
      DARK_THEME.raised,
      DARK_THEME.soft,
      DARK_THEME.unreadSurface,
      DARK_THEME.attentionTile,
    ]) {
      expect(contrast(DARK_THEME.text, surface)).toBeGreaterThanOrEqual(7);
      expect(contrast(DARK_THEME.muted, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
