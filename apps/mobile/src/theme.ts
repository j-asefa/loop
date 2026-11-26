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
  onGreen: string;
  greenSoft: string;
  orange: string;
  orangeSoft: string;
  blue: string;
  blueSoft: string;
  purple: string;
  purpleSoft: string;
  rose: string;
  roseSoft: string;
  scrim: string;
  pillBg: string;
  tabBarBg: string;
  blurTint: "systemChromeMaterialDark" | "systemChromeMaterialLight";
};

/**
 * Dark counterpart to the sage & risograph swatch palette: deep pine-charcoal
 * surfaces paired with sage green, warm ochre, coral, cerulean, and rose.
 */
export const DARK_THEME: LoopTheme = {
  isDark: true,
  bg: "#171d1a",
  surface: "#202824",
  raised: "#28322d",
  soft: "#252f2a",
  text: "#f4f2ea",
  muted: "#a3b3aa",
  line: "#34413a",
  brass: "#e0a350",
  brassText: "#eab86f",
  onBrass: "#171d1a",
  attention: "#2c281f",
  attentionTile: "#342f24",
  attentionLine: "rgba(224, 163, 80, 0.36)",
  green: "#7eb098",
  onGreen: "#171d1a",
  greenSoft: "rgba(126, 176, 152, 0.18)",
  orange: "#e07b77",
  orangeSoft: "rgba(210, 96, 92, 0.18)",
  blue: "#5aaef0",
  blueSoft: "rgba(34, 136, 220, 0.18)",
  purple: "#b4b4e8",
  purpleSoft: "rgba(120, 120, 172, 0.20)",
  rose: "#e098a8",
  roseSoft: "rgba(224, 152, 168, 0.20)",
  scrim: "rgba(15, 20, 17, 0.72)",
  pillBg: "rgba(32, 40, 36, 0.88)",
  tabBarBg: "rgba(23, 29, 26, 0.84)",
  blurTint: "systemChromeMaterialDark",
};

/**
 * Sage celadon ground with warm cream cards and forest/cerulean/ochre/coral/
 * periwinkle/rose accents.
 */
export const LIGHT_THEME: LoopTheme = {
  isDark: false,
  bg: "#7eb098",
  surface: "#fcfbf7",
  raised: "#ffffff",
  soft: "#ece9df",
  text: "#1c211e",
  muted: "#363d38",
  line: "rgba(28, 33, 30, 0.16)",
  brass: "#e0a350",
  brassText: "#553204",
  onBrass: "#1c211e",
  attention: "#f5ebd8",
  attentionTile: "#faf4e8",
  attentionLine: "rgba(224, 163, 80, 0.58)",
  green: "#1f6835",
  onGreen: "#ffffff",
  greenSoft: "#e6f3ea",
  orange: "#6c1c18",
  orangeSoft: "#fae6e5",
  blue: "#0a3966",
  blueSoft: "#e5f0fa",
  purple: "#494982",
  purpleSoft: "#ececf6",
  rose: "#8c3b50",
  roseSoft: "#f8e9ed",
  scrim: "rgba(92, 132, 113, 0.72)",
  pillBg: "rgba(252, 251, 247, 0.92)",
  tabBarBg: "rgba(247, 245, 238, 0.88)",
  blurTint: "systemChromeMaterialLight",
};

export const AVATAR_PALETTE: Record<string, { bg: string; fg: string }> = {
  willow: { bg: "#e098a8", fg: "#1c211e" },
  cedar: { bg: "#e0a350", fg: "#1c211e" },
  iris: { bg: "#7878ac", fg: "#fcfbf7" },
  fern: { bg: "#787870", fg: "#fcfbf7" },
  maple: { bg: "#d2605c", fg: "#fcfbf7" },
};

export function avatarColors(name: string): { bg: string; fg: string } {
  const key = name.replace(/^@/, "").toLowerCase();
  return AVATAR_PALETTE[key] ?? { bg: "#32884a", fg: "#fcfbf7" };
}
