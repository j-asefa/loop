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
  unreadSurface: string;
  unreadLine: string;
  green: string;
  onGreen: string;
  greenSoft: string;
  orange: string;
  orangeSoft: string;
  blue: string;
  onBlue: string;
  blueSoft: string;
  purple: string;
  purpleSoft: string;
  rose: string;
  roseSoft: string;
  scrim: string;
  pillBg: string;
  tabBarBg: string;
  tabBarLine: string;
  tabBarActiveBg: string;
  tabBarActiveText: string;
  blurTint: "systemChromeMaterialDark" | "systemChromeMaterialLight";
};

/**
 * Garden at night: a deep evergreen background, brighter leaf-green surfaces,
 * warm ivory text, and amber highlights.
 */
export const DARK_THEME: LoopTheme = {
  isDark: true,
  bg: "#101f19",
  surface: "#23382e",
  raised: "#2e463a",
  soft: "#2a4035",
  text: "#f6f3e7",
  muted: "#c0d4c8",
  line: "#587667",
  brass: "#edc47e",
  brassText: "#f7d498",
  onBrass: "#292013",
  attention: "#413522",
  attentionTile: "#4c3e28",
  attentionLine: "#ab8651",
  unreadSurface: "#413522",
  unreadLine: "#ab8651",
  green: "#b4df9c",
  onGreen: "#172817",
  greenSoft: "#344a32",
  orange: "#fcb1ad",
  orangeSoft: "#513437",
  blue: "#91c9f0",
  onBlue: "#142b37",
  blueSoft: "#2e4957",
  purple: "#e1d8fb",
  purpleSoft: "#3e3a56",
  rose: "#f6b3c3",
  roseSoft: "#50343f",
  scrim: "rgba(8, 15, 11, 0.76)",
  pillBg: "rgba(35, 56, 46, 0.94)",
  tabBarBg: "#294438",
  tabBarLine: "#7aa58d",
  tabBarActiveBg: "#edc47e",
  tabBarActiveText: "#292013",
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
  unreadSurface: "#f5e4be",
  unreadLine: "#c9892f",
  green: "#1f6835",
  onGreen: "#ffffff",
  greenSoft: "#e6f3ea",
  orange: "#6c1c18",
  orangeSoft: "#fae6e5",
  blue: "#135ba0",
  onBlue: "#ffffff",
  blueSoft: "#e5f0fa",
  purple: "#494982",
  purpleSoft: "#ececf6",
  rose: "#8c3b50",
  roseSoft: "#f8e9ed",
  scrim: "rgba(92, 132, 113, 0.72)",
  pillBg: "rgba(252, 251, 247, 0.92)",
  tabBarBg: "#fcfbf7",
  tabBarLine: "#31473c",
  tabBarActiveBg: "#f5e4be",
  tabBarActiveText: "#553204",
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
