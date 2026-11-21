import fs from "node:fs";
import path from "node:path";

// Exact 100 character -> family map from src/client/agentAppearance.ts
export const CHARACTER_FAMILIES = {
  atlas: "atlas",
  nova: "nova",
  sage: "sage",
  echo: "echo",
  orbit: "orbit",
  moss: "moss",
  ember: "ember",
  cobalt: "cobalt",
  owl: "owl",
  prism: "prism",
  pebble: "pebble",
  flint: "flint",
  archer: "atlas",
  beacon: "atlas",
  delta: "atlas",
  falcon: "atlas",
  mercury: "atlas",
  merlin: "atlas",
  horizon: "atlas",
  summit: "atlas",
  aurora: "nova",
  blossom: "nova",
  dawn: "nova",
  lily: "nova",
  luna: "nova",
  opal: "nova",
  snow: "nova",
  winter: "nova",
  acorn: "sage",
  alder: "sage",
  basil: "sage",
  cedar: "sage",
  fern: "sage",
  forest: "sage",
  jade: "sage",
  olive: "sage",
  cosmos: "echo",
  moon: "echo",
  raven: "echo",
  slate: "echo",
  storm: "echo",
  velvet: "echo",
  onyx: "echo",
  zephyr: "echo",
  comet: "orbit",
  meteor: "orbit",
  orion: "orbit",
  solar: "orbit",
  venus: "orbit",
  tide: "orbit",
  reef: "orbit",
  clover: "moss",
  cricket: "moss",
  ivy: "moss",
  juniper: "moss",
  leaf: "moss",
  spruce: "moss",
  willow: "moss",
  amber: "ember",
  coral: "ember",
  fox: "ember",
  garnet: "ember",
  ginger: "ember",
  ruby: "ember",
  terra: "ember",
  brook: "cobalt",
  cove: "cobalt",
  indigo: "cobalt",
  lake: "cobalt",
  ocean: "cobalt",
  river: "cobalt",
  sky: "cobalt",
  finch: "owl",
  heron: "owl",
  kestrel: "owl",
  lark: "owl",
  robin: "owl",
  sparrow: "owl",
  wren: "owl",
  aster: "prism",
  iris: "prism",
  lavender: "prism",
  lilac: "prism",
  mica: "prism",
  quartz: "prism",
  violet: "prism",
  dune: "pebble",
  hazel: "pebble",
  maple: "pebble",
  oak: "pebble",
  stone: "pebble",
  topaz: "pebble",
  marigold: "pebble",
  birch: "flint",
  cypress: "flint",
  lynx: "flint",
  otter: "flint",
  pine: "flint",
  sequoia: "flint",
  swift: "flint",
};

// 9 curated mid-century mineral/botanical colorways (warm, earthy, crisp at 24px)
const PALETTES = [
  {
    bg: "#d8b89c",
    main: "#d16236",
    dark: "#9f4120",
    light: "#f7f2e8",
    accent: "#d8b048",
    eye: "#1f1e1c",
  },
  {
    bg: "#a8bcbd",
    main: "#365669",
    dark: "#243b49",
    light: "#f5f3ec",
    accent: "#deb64c",
    eye: "#1b2024",
  },
  {
    bg: "#adb9a3",
    main: "#2f5343",
    dark: "#203b2f",
    light: "#f4f1e8",
    accent: "#d8b048",
    eye: "#1b221e",
  },
  {
    bg: "#bfb5c0",
    main: "#3a3342",
    dark: "#25202b",
    light: "#f5f2ee",
    accent: "#e0ba50",
    eye: "#1b181f",
  },
  {
    bg: "#d9c48c",
    main: "#8a5a2b",
    dark: "#633e1c",
    light: "#f8f4e8",
    accent: "#c75d38",
    eye: "#201b16",
  },
  {
    bg: "#c5b5a8",
    main: "#5e463a",
    dark: "#3f2e26",
    light: "#f6f2ea",
    accent: "#d9a944",
    eye: "#1e1916",
  },
  {
    bg: "#b5c2bd",
    main: "#395d57",
    dark: "#25403c",
    light: "#f3f5f0",
    accent: "#d67746",
    eye: "#1a2220",
  },
  {
    bg: "#cfc2b2",
    main: "#464d57",
    dark: "#2d323a",
    light: "#f6f4ee",
    accent: "#d4a83f",
    eye: "#191c20",
  },
  {
    bg: "#c7b6a4",
    main: "#9c4738",
    dark: "#723025",
    light: "#f7f2e9",
    accent: "#dfba52",
    eye: "#211918",
  },
];

// Each family has a preferred primary colorway index so named characters feel natural
const FAMILY_OFFSET = {
  ember: 0,
  owl: 1,
  moss: 2,
  prism: 3,
  pebble: 4,
  flint: 5,
  cobalt: 6,
  echo: 7,
  atlas: 8,
  sage: 2,
  nova: 3,
  orbit: 1,
};

function renderFamily(family, p, v) {
  // Subtle geometric accent shift per variant so every silhouette feels handcrafted & distinct
  const shift = v % 3 === 1 ? -1 : v % 3 === 2 ? 1 : 0;
  const collar = v >= 4;
  switch (family) {
    case "ember": // Charley Harper Geometric Fox
      return `
  <polygon points="15,${14 + shift} 27,26 15,34" fill="${p.dark}"/>
  <polygon points="49,${14 + shift} 37,26 49,34" fill="${p.dark}"/>
  <polygon points="15,28 49,28 32,52" fill="${p.main}"/>
  <polygon points="15,28 32,52 22,42" fill="${p.light}"/>
  <polygon points="49,28 32,52 42,42" fill="${p.light}"/>
  ${collar ? `<polygon points="28,28 36,28 32,33" fill="${p.accent}"/>` : ""}
  <circle cx="25" cy="34" r="2.6" fill="${p.eye}"/>
  <circle cx="39" cy="34" r="2.6" fill="${p.eye}"/>
  <circle cx="32" cy="49" r="3.4" fill="${p.eye}"/>`;

    case "owl": // Charley Harper Geometric Owl
      return `
  <polygon points="14,${16 + shift} 26,22 18,30" fill="${p.dark}"/>
  <polygon points="50,${16 + shift} 38,22 46,30" fill="${p.dark}"/>
  <circle cx="32" cy="36" r="18" fill="${p.main}"/>
  ${collar ? `<path d="M20,46 Q32,53 44,46 L38,52 L26,52 Z" fill="${p.dark}"/>` : ""}
  <circle cx="24.5" cy="33" r="7.5" fill="${p.light}"/>
  <circle cx="39.5" cy="33" r="7.5" fill="${p.light}"/>
  <circle cx="24.5" cy="33" r="${v % 2 === 0 ? 3 : 3.5}" fill="${p.eye}"/>
  <circle cx="39.5" cy="33" r="${v % 2 === 0 ? 3 : 3.5}" fill="${p.eye}"/>
  <polygon points="29,39 35,39 32,45" fill="${p.accent}"/>`;

    case "moss": // Charley Harper Geometric Wren / Songbird
      return `
  <polygon points="44,${24 + shift} 55,27 44,31" fill="${p.accent}"/>
  <path d="M16,44 A19,19 0 0,1 46,24 L46,44 Z" fill="${p.main}"/>
  <path d="M22,44 A12,12 0 0,1 46,32 L46,44 Z" fill="${p.light}"/>
  ${collar ? `<path d="M16,44 L24,44 L16,36 Z" fill="${p.dark}"/>` : `<rect x="25" y="44" width="14" height="3" rx="1.5" fill="${p.dark}"/>`}
  <circle cx="39" cy="27" r="2.8" fill="${p.light}"/>
  <circle cx="39.6" cy="27" r="1.3" fill="${p.eye}"/>`;

    case "prism": // Charley Harper Geometric Cat / Lynx
      return `
  <polygon points="16,${15 + shift} 28,26 16,36" fill="${p.dark}"/>
  <polygon points="48,${15 + shift} 36,26 48,36" fill="${p.dark}"/>
  <circle cx="32" cy="37" r="16" fill="${p.main}"/>
  ${collar ? `<polygon points="29,21 35,21 32,27" fill="${p.dark}"/>` : ""}
  <ellipse cx="25.5" cy="36" rx="3.4" ry="4.2" fill="${p.accent}"/>
  <ellipse cx="38.5" cy="36" rx="3.4" ry="4.2" fill="${p.accent}"/>
  <rect x="24.9" y="33.4" width="1.2" height="5.2" rx="0.6" fill="${p.eye}"/>
  <rect x="37.9" y="33.4" width="1.2" height="5.2" rx="0.6" fill="${p.eye}"/>
  <polygon points="30,42 34,42 32,44.8" fill="${p.light}"/>`;

    case "cobalt": // Charley Harper Geometric Otter
      return `
  <circle cx="17" cy="${26 + shift}" r="5.5" fill="${p.dark}"/>
  <circle cx="47" cy="${26 + shift}" r="5.5" fill="${p.dark}"/>
  <circle cx="32" cy="34" r="17" fill="${p.main}"/>
  <ellipse cx="32" cy="40" rx="11" ry="8.5" fill="${p.light}"/>
  ${collar ? `<ellipse cx="32" cy="23" rx="6" ry="2.5" fill="${p.dark}"/>` : ""}
  <circle cx="24.5" cy="30" r="2.6" fill="${p.eye}"/>
  <circle cx="39.5" cy="30" r="2.6" fill="${p.eye}"/>
  <ellipse cx="32" cy="37.5" rx="4.2" ry="2.8" fill="${p.eye}"/>
  <circle cx="32" cy="43.5" r="1.4" fill="${p.accent}"/>`;

    case "echo": // Charley Harper Geometric Raven / Crow
      return `
  <path d="M12,${31 + shift} Q22,22 30,27 L29,35 Q20,34 12,${31 + shift} Z" fill="${p.accent}"/>
  <path d="M24,22 A15,15 0 0,1 48,34 L48,50 L24,50 L24,34 Z" fill="${p.main}"/>
  <path d="M24,42 L48,42 L48,50 L24,50 Z" fill="${p.dark}"/>
  ${collar ? `<circle cx="35" cy="30" r="4.8" fill="${p.light}"/><circle cx="35" cy="30" r="2.2" fill="${p.eye}"/>` : `<circle cx="35" cy="30" r="4" fill="${p.light}"/><circle cx="34.5" cy="30" r="2" fill="${p.eye}"/>`}`;

    case "atlas": // Charley Harper Geometric Eagle / Falcon
      return `
  <path d="M18,50 L18,31 A14,14 0 0,1 46,31 L46,50 Z" fill="${p.main}"/>
  <path d="M21,50 L21,31 A11,11 0 0,1 43,31 L43,38 L32,44 L21,38 Z" fill="${p.light}"/>
  <path d="M41,${25 + shift} Q52,25 53,34 Q48,31 41,33 Z" fill="${p.accent}"/>
  <path d="M18,24 L30,27 L18,30 Z" fill="${p.dark}"/>
  ${collar ? `<polygon points="22,45 32,50 42,45 42,50 22,50" fill="${p.dark}"/>` : ""}
  <circle cx="35" cy="28" r="3.2" fill="${p.eye}"/>
  <circle cx="35.8" cy="27.4" r="1.1" fill="${p.light}"/>`;

    case "pebble": // Charley Harper Geometric Bear / Badger
      return `
  <circle cx="18" cy="${20 + shift}" r="6.5" fill="${p.dark}"/>
  <circle cx="46" cy="${20 + shift}" r="6.5" fill="${p.dark}"/>
  <circle cx="18" cy="${20 + shift}" r="3" fill="${p.accent}"/>
  <circle cx="46" cy="${20 + shift}" r="3" fill="${p.accent}"/>
  <rect x="15" y="21" width="34" height="30" rx="15" fill="${p.main}"/>
  <circle cx="32" cy="40" r="8.5" fill="${p.light}"/>
  <circle cx="24" cy="32" r="2.6" fill="${p.eye}"/>
  <circle cx="40" cy="32" r="2.6" fill="${p.eye}"/>
  <polygon points="28.5,37 35.5,37 32,42" fill="${p.eye}"/>`;

    case "flint": // Charley Harper Geometric Hare / Rabbit
      return `
  <rect x="20" y="${10 + shift}" width="8" height="22" rx="4" fill="${p.main}"/>
  <rect x="36" y="${10 + shift}" width="8" height="22" rx="4" fill="${p.main}"/>
  <rect x="22.4" y="${14 + shift}" width="3.2" height="14" rx="1.6" fill="${p.light}"/>
  <rect x="38.4" y="${14 + shift}" width="3.2" height="14" rx="1.6" fill="${p.light}"/>
  <ellipse cx="32" cy="39" rx="15" ry="13" fill="${p.main}"/>
  ${collar ? `<ellipse cx="32" cy="44" rx="8" ry="5.5" fill="${p.light}"/>` : ""}
  <circle cx="25.5" cy="37" r="2.6" fill="${p.eye}"/>
  <circle cx="38.5" cy="37" r="2.6" fill="${p.eye}"/>
  <circle cx="32" cy="43" r="2.4" fill="${p.accent}"/>`;

    case "sage": // Charley Harper Geometric Frog
      return `
  <circle cx="22" cy="${25 + shift}" r="7.5" fill="${p.main}"/>
  <circle cx="42" cy="${25 + shift}" r="7.5" fill="${p.main}"/>
  <circle cx="22" cy="${25 + shift}" r="4.2" fill="${p.light}"/>
  <circle cx="42" cy="${25 + shift}" r="4.2" fill="${p.light}"/>
  <circle cx="22" cy="${25 + shift}" r="2.2" fill="${p.eye}"/>
  <circle cx="42" cy="${25 + shift}" r="2.2" fill="${p.eye}"/>
  <ellipse cx="32" cy="39" rx="18" ry="13" fill="${p.main}"/>
  <path d="M18,42 Q32,50 46,42 Q32,53 18,42 Z" fill="${p.light}"/>
  <circle cx="20" cy="39" r="2.4" fill="${p.accent}"/>
  <circle cx="44" cy="39" r="2.4" fill="${p.accent}"/>`;

    case "nova": // Charley Harper Geometric Moth
      return `
  <polygon points="32,32 12,${20 + shift} 16,38" fill="${p.main}"/>
  <polygon points="32,32 52,${20 + shift} 48,38" fill="${p.main}"/>
  <polygon points="32,34 17,48 28,45" fill="${p.dark}"/>
  <polygon points="32,34 47,48 36,45" fill="${p.dark}"/>
  <circle cx="20" cy="29" r="3.4" fill="${p.accent}"/>
  <circle cx="44" cy="29" r="3.4" fill="${p.accent}"/>
  <rect x="29.5" y="21" width="5" height="25" rx="2.5" fill="${p.eye}"/>
  <circle cx="27" cy="18" r="1.8" fill="${p.light}"/>
  <circle cx="37" cy="18" r="1.8" fill="${p.light}"/>`;

    case "orbit": // Charley Harper Geometric Whale
    default:
      return `
  <path d="M13,38 A18,16 0 0,1 46,31 L53,${24 + shift} L50,36 L53,42 L45,39 A18,12 0 0,1 13,38 Z" fill="${p.main}"/>
  <path d="M14,38 Q26,35 38,41 Q26,46 14,38 Z" fill="${p.light}"/>
  <circle cx="23" cy="33" r="2.4" fill="${p.light}"/>
  <circle cx="23" cy="33" r="1.2" fill="${p.eye}"/>
  ${collar ? `<circle cx="30" cy="19" r="2.6" fill="${p.accent}"/>` : `<path d="M29,22 L29,15 M29,17 L25,14 M29,17 L33,14" stroke="${p.accent}" stroke-width="2.2" stroke-linecap="round"/>`}`;
  }
}

export function buildAllAnimalSvgs(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const familyCounts = new Map();
  let count = 0;
  for (const [name, family] of Object.entries(CHARACTER_FAMILIES)) {
    const idx = familyCounts.get(family) ?? 0;
    familyCounts.set(family, idx + 1);
    const palette = PALETTES[(FAMILY_OFFSET[family] + idx) % PALETTES.length];
    const body = renderFamily(family, palette, idx);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="384" viewBox="0 0 64 64"><rect width="64" height="64" fill="${palette.bg}"/>${body.replace(/\n\s+/g, "")}</svg>\n`;
    fs.writeFileSync(path.join(outDir, `${name}.svg`), svg, "utf8");
    count++;
  }
  return count;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) throw new Error("Pass output dir");
  const n = buildAllAnimalSvgs(target);
  console.log(`Generated ${n} geometric animal SVGs in ${target}`);
}
