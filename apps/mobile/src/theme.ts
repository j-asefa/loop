export type LoopTheme = {
  isDark: boolean;
  bg: string;
  surface: string;
  raised: string;
  soft: string;
  text: string;
  muted: string;
  line: string;
  brass: string;
  brassText: string;
  onBrass: string;
  attention: string;
  attentionTile: string;
  attentionLine: string;
  green: string;
  greenSoft: string;
  orange: string;
  orangeSoft: string;
  blue: string;
  blueSoft: string;
  scrim: string;
  pillBg: string;
  blurTint: "systemChromeMaterialDark" | "systemChromeMaterialLight";
};

/**
 * Loop's signature warm dark charcoal + brass palette (matching dark mode in
 * src/client/style.css). Structured as a typed token object so Light / System
 * theme can be toggled cleanly next.
 */
export const DARK_THEME: LoopTheme = {
  isDark: true,
  bg: "#141412",
  surface: "#1d1d1a",
  raised: "#262622",
  soft: "#232320",
  text: "#f5f5f2",
  muted: "#a9a9a1",
  line: "#333431",
  brass: "#c9aa4f",
  brassText: "#e0c46f",
  onBrass: "#1c1c1a",
  attention: "#292519",
  attentionTile: "#332e1e",
  attentionLine: "rgba(224, 196, 111, 0.32)",
  green: "#78cf8a",
  greenSoft: "rgba(120, 207, 138, 0.16)",
  orange: "#e49d64",
  orangeSoft: "rgba(228, 157, 100, 0.16)",
  blue: "#86b0ff",
  blueSoft: "rgba(134, 176, 255, 0.16)",
  scrim: "rgba(10, 10, 9, 0.62)",
  pillBg: "rgba(29, 29, 26, 0.86)",
  blurTint: "systemChromeMaterialDark",
};

export const LIGHT_THEME: LoopTheme = {
  isDark: false,
  bg: "#f5f5f2",
  surface: "#ffffff",
  raised: "#ffffff",
  soft: "#f7f7f4",
  text: "#1d1d21",
  muted: "#6b6b72",
  line: "#e4e4df",
  brass: "#c9aa4f",
  brassText: "#7b6320",
  onBrass: "#1d1d21",
  attention: "#f8f3e3",
  attentionTile: "#fcf9ef",
  attentionLine: "rgba(155, 125, 42, 0.36)",
  green: "#2f8545",
  greenSoft: "rgba(47, 133, 69, 0.12)",
  orange: "#b55d1c",
  orangeSoft: "rgba(181, 93, 28, 0.12)",
  blue: "#2f64c7",
  blueSoft: "rgba(47, 100, 199, 0.12)",
  scrim: "rgba(245, 245, 242, 0.56)",
  pillBg: "rgba(255, 255, 255, 0.88)",
  blurTint: "systemChromeMaterialLight",
};

export const AVATAR_PALETTE: Record<string, { bg: string; fg: string }> = {
  willow: { bg: "#3a2e25", fg: "#f1c295" },
  cedar: { bg: "#263329", fg: "#9ad6a8" },
  iris: { bg: "#292c3e", fg: "#a8b8ff" },
  fern: { bg: "#243432", fg: "#8fd8cf" },
  maple: { bg: "#3c2927", fg: "#f2a8a0" },
};

export function avatarColors(name: string): { bg: string; fg: string } {
  const key = name.replace(/^@/, "").toLowerCase();
  return AVATAR_PALETTE[key] ?? { bg: "#2f2c23", fg: "#e0c46f" };
}
