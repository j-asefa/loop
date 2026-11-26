export type AnimalPalette = {
  bg: string;
  main: string;
  dark: string;
  light: string;
  accent: string;
  eye: string;
};

export const PALETTES: readonly AnimalPalette[] = [
  {
    bg: "#e098a8",
    main: "#d2605c",
    dark: "#913532",
    light: "#f7f5ee",
    accent: "#e0a350",
    eye: "#1c211e",
  },
  {
    bg: "#7eb098",
    main: "#2288dc",
    dark: "#155a96",
    light: "#f7f5ee",
    accent: "#e0a350",
    eye: "#1c211e",
  },
  {
    bg: "#e0a350",
    main: "#32884a",
    dark: "#1f5a2f",
    light: "#f7f5ee",
    accent: "#d2605c",
    eye: "#1c211e",
  },
  {
    bg: "#7878ac",
    main: "#2288dc",
    dark: "#484878",
    light: "#f7f5ee",
    accent: "#e0a350",
    eye: "#1c211e",
  },
  {
    bg: "#e0a350",
    main: "#d2605c",
    dark: "#787870",
    light: "#f7f5ee",
    accent: "#32884a",
    eye: "#1c211e",
  },
  {
    bg: "#787870",
    main: "#32884a",
    dark: "#1c211e",
    light: "#f7f5ee",
    accent: "#e098a8",
    eye: "#1c211e",
  },
  {
    bg: "#7eb098",
    main: "#7878ac",
    dark: "#494982",
    light: "#f7f5ee",
    accent: "#e0a350",
    eye: "#1c211e",
  },
  {
    bg: "#e098a8",
    main: "#787870",
    dark: "#474742",
    light: "#f7f5ee",
    accent: "#2288dc",
    eye: "#1c211e",
  },
  {
    bg: "#7878ac",
    main: "#d2605c",
    dark: "#8e3936",
    light: "#f7f5ee",
    accent: "#e0a350",
    eye: "#1c211e",
  },
];

export const FAMILY_OFFSET = {
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
} as const;

export type AnimalFamily = keyof typeof FAMILY_OFFSET;

const CHARACTERS = {
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
} as const satisfies Record<string, AnimalFamily>;

type CharacterName = keyof typeof CHARACTERS;
const CHARACTER_NAMES = Object.keys(CHARACTERS) as CharacterName[];

const familyVariantIndex = new Map<CharacterName, number>();
const paletteByCharacter = new Map<CharacterName, AnimalPalette>();
{
  const counts = new Map<AnimalFamily, number>();
  for (const name of CHARACTER_NAMES) {
    const family = CHARACTERS[name];
    const idx = counts.get(family) ?? 0;
    counts.set(family, idx + 1);
    familyVariantIndex.set(name, idx);
    paletteByCharacter.set(
      name,
      PALETTES[(FAMILY_OFFSET[family] + idx) % PALETTES.length],
    );
  }
}

function renderAnimalBody(
  family: AnimalFamily,
  p: AnimalPalette,
  v: number,
): string {
  const shift = v % 3 === 1 ? -1 : v % 3 === 2 ? 1 : 0;
  const collar = v >= 4;
  switch (family) {
    case "ember":
      return `<polygon points="15,${14 + shift} 27,26 15,34" fill="${p.dark}"/><polygon points="49,${14 + shift} 37,26 49,34" fill="${p.dark}"/><polygon points="15,28 49,28 32,52" fill="${p.main}"/><polygon points="15,28 32,52 22,42" fill="${p.light}"/><polygon points="49,28 32,52 42,42" fill="${p.light}"/>${collar ? `<polygon points="28,28 36,28 32,33" fill="${p.accent}"/>` : ""}<circle cx="25" cy="34" r="2.6" fill="${p.eye}"/><circle cx="39" cy="34" r="2.6" fill="${p.eye}"/><circle cx="32" cy="49" r="3.4" fill="${p.eye}"/>`;
    case "owl":
      return `<polygon points="14,${16 + shift} 26,22 18,30" fill="${p.dark}"/><polygon points="50,${16 + shift} 38,22 46,30" fill="${p.dark}"/><circle cx="32" cy="36" r="18" fill="${p.main}"/>${collar ? `<path d="M20,46 Q32,53 44,46 L38,52 L26,52 Z" fill="${p.dark}"/>` : ""}<circle cx="24.5" cy="33" r="7.5" fill="${p.light}"/><circle cx="39.5" cy="33" r="7.5" fill="${p.light}"/><circle cx="24.5" cy="33" r="${v % 2 === 0 ? 3 : 3.5}" fill="${p.eye}"/><circle cx="39.5" cy="33" r="${v % 2 === 0 ? 3 : 3.5}" fill="${p.eye}"/><polygon points="29,39 35,39 32,45" fill="${p.accent}"/>`;
    case "moss":
      return `<polygon points="44,${24 + shift} 55,27 44,31" fill="${p.accent}"/><path d="M16,44 A19,19 0 0,1 46,24 L46,44 Z" fill="${p.main}"/><path d="M22,44 A12,12 0 0,1 46,32 L46,44 Z" fill="${p.light}"/>${collar ? `<path d="M16,44 L24,44 L16,36 Z" fill="${p.dark}"/>` : `<rect x="25" y="44" width="14" height="3" rx="1.5" fill="${p.dark}"/>`}<circle cx="39" cy="27" r="2.8" fill="${p.light}"/><circle cx="39.6" cy="27" r="1.3" fill="${p.eye}"/>`;
    case "prism":
      return `<polygon points="16,${15 + shift} 28,26 16,36" fill="${p.dark}"/><polygon points="48,${15 + shift} 36,26 48,36" fill="${p.dark}"/><circle cx="32" cy="37" r="16" fill="${p.main}"/>${collar ? `<polygon points="29,21 35,21 32,27" fill="${p.dark}"/>` : ""}<ellipse cx="25.5" cy="36" rx="3.4" ry="4.2" fill="${p.accent}"/><ellipse cx="38.5" cy="36" rx="3.4" ry="4.2" fill="${p.accent}"/><rect x="24.9" y="33.4" width="1.2" height="5.2" rx="0.6" fill="${p.eye}"/><rect x="37.9" y="33.4" width="1.2" height="5.2" rx="0.6" fill="${p.eye}"/><polygon points="30,42 34,42 32,44.8" fill="${p.light}"/>`;
    case "cobalt":
      return `<circle cx="17" cy="${26 + shift}" r="5.5" fill="${p.dark}"/><circle cx="47" cy="${26 + shift}" r="5.5" fill="${p.dark}"/><circle cx="32" cy="34" r="17" fill="${p.main}"/><ellipse cx="32" cy="40" rx="11" ry="8.5" fill="${p.light}"/>${collar ? `<ellipse cx="32" cy="23" rx="6" ry="2.5" fill="${p.dark}"/>` : ""}<circle cx="24.5" cy="30" r="2.6" fill="${p.eye}"/><circle cx="39.5" cy="30" r="2.6" fill="${p.eye}"/><ellipse cx="32" cy="37.5" rx="4.2" ry="2.8" fill="${p.eye}"/><circle cx="32" cy="43.5" r="1.4" fill="${p.accent}"/>`;
    case "echo":
      return `<path d="M12,${31 + shift} Q22,22 30,27 L29,35 Q20,34 12,${31 + shift} Z" fill="${p.accent}"/><path d="M24,22 A15,15 0 0,1 48,34 L48,50 L24,50 L24,34 Z" fill="${p.main}"/><path d="M24,42 L48,42 L48,50 L24,50 Z" fill="${p.dark}"/>${collar ? `<circle cx="35" cy="30" r="4.8" fill="${p.light}"/><circle cx="35" cy="30" r="2.2" fill="${p.eye}"/>` : `<circle cx="35" cy="30" r="4" fill="${p.light}"/><circle cx="34.5" cy="30" r="2" fill="${p.eye}"/>`}`;
    case "atlas":
      return `<path d="M18,50 L18,31 A14,14 0 0,1 46,31 L46,50 Z" fill="${p.main}"/><path d="M21,50 L21,31 A11,11 0 0,1 43,31 L43,38 L32,44 L21,38 Z" fill="${p.light}"/><path d="M41,${25 + shift} Q52,25 53,34 Q48,31 41,33 Z" fill="${p.accent}"/><path d="M18,24 L30,27 L18,30 Z" fill="${p.dark}"/>${collar ? `<polygon points="22,45 32,50 42,45 42,50 22,50" fill="${p.dark}"/>` : ""}<circle cx="35" cy="28" r="3.2" fill="${p.eye}"/><circle cx="35.8" cy="27.4" r="1.1" fill="${p.light}"/>`;
    case "pebble":
      return `<circle cx="18" cy="${20 + shift}" r="6.5" fill="${p.dark}"/><circle cx="46" cy="${20 + shift}" r="6.5" fill="${p.dark}"/><circle cx="18" cy="${20 + shift}" r="3" fill="${p.accent}"/><circle cx="46" cy="${20 + shift}" r="3" fill="${p.accent}"/><rect x="15" y="21" width="34" height="30" rx="15" fill="${p.main}"/><circle cx="32" cy="40" r="8.5" fill="${p.light}"/><circle cx="24" cy="32" r="2.6" fill="${p.eye}"/><circle cx="40" cy="32" r="2.6" fill="${p.eye}"/><polygon points="28.5,37 35.5,37 32,42" fill="${p.eye}"/>`;
    case "flint":
      return `<rect x="20" y="${10 + shift}" width="8" height="22" rx="4" fill="${p.main}"/><rect x="36" y="${10 + shift}" width="8" height="22" rx="4" fill="${p.main}"/><rect x="22.4" y="${14 + shift}" width="3.2" height="14" rx="1.6" fill="${p.light}"/><rect x="38.4" y="${14 + shift}" width="3.2" height="14" rx="1.6" fill="${p.light}"/><ellipse cx="32" cy="39" rx="15" ry="13" fill="${p.main}"/>${collar ? `<ellipse cx="32" cy="44" rx="8" ry="5.5" fill="${p.light}"/>` : ""}<circle cx="25.5" cy="37" r="2.6" fill="${p.eye}"/><circle cx="38.5" cy="37" r="2.6" fill="${p.eye}"/><circle cx="32" cy="43" r="2.4" fill="${p.accent}"/>`;
    case "sage":
      return `<circle cx="22" cy="${25 + shift}" r="7.5" fill="${p.main}"/><circle cx="42" cy="${25 + shift}" r="7.5" fill="${p.main}"/><circle cx="22" cy="${25 + shift}" r="4.2" fill="${p.light}"/><circle cx="42" cy="${25 + shift}" r="4.2" fill="${p.light}"/><circle cx="22" cy="${25 + shift}" r="2.2" fill="${p.eye}"/><circle cx="42" cy="${25 + shift}" r="2.2" fill="${p.eye}"/><ellipse cx="32" cy="39" rx="18" ry="13" fill="${p.main}"/><path d="M18,42 Q32,50 46,42 Q32,53 18,42 Z" fill="${p.light}"/><circle cx="20" cy="39" r="2.4" fill="${p.accent}"/><circle cx="44" cy="39" r="2.4" fill="${p.accent}"/>`;
    case "nova":
      return `<polygon points="32,32 12,${20 + shift} 16,38" fill="${p.main}"/><polygon points="32,32 52,${20 + shift} 48,38" fill="${p.main}"/><polygon points="32,34 17,48 28,45" fill="${p.dark}"/><polygon points="32,34 47,48 36,45" fill="${p.dark}"/><circle cx="20" cy="29" r="3.4" fill="${p.accent}"/><circle cx="44" cy="29" r="3.4" fill="${p.accent}"/><rect x="29.5" y="21" width="5" height="25" rx="2.5" fill="${p.eye}"/><circle cx="27" cy="18" r="1.8" fill="${p.light}"/><circle cx="37" cy="18" r="1.8" fill="${p.light}"/>`;
    case "orbit":
    default:
      return `<path d="M13,38 A18,16 0 0,1 46,31 L53,${24 + shift} L50,36 L53,42 L45,39 A18,12 0 0,1 13,38 Z" fill="${p.main}"/><path d="M14,38 Q26,35 38,41 Q26,46 14,38 Z" fill="${p.light}"/><circle cx="23" cy="33" r="2.4" fill="${p.light}"/><circle cx="23" cy="33" r="1.2" fill="${p.eye}"/>${collar ? `<circle cx="30" cy="19" r="2.6" fill="${p.accent}"/>` : `<path d="M29,22 L29,15 M29,17 L25,14 M29,17 L33,14" stroke="${p.accent}" stroke-width="2.2" stroke-linecap="round"/>`}`;
  }
}

const COVER_W = 1600;
const COVER_H = 533;

function mix(from: string, to: string, amount: number): string {
  const ch = (color: string, i: number) =>
    parseInt(color.slice(1 + i * 2, 3 + i * 2), 16);
  return (
    "#" +
    [0, 1, 2]
      .map((i) =>
        Math.round(ch(from, i) + (ch(to, i) - ch(from, i)) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

function repeat(count: number, draw: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => draw(i)).join("");
}

const cloud = (x: number, y: number, w: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="30" rx="15" fill="${fill}"/>`;

const bird = (x: number, y: number, s: number, stroke: string) =>
  `<path d="M${x},${y} l${s},${s * 0.6} l${s},${-s * 0.6}" fill="none" stroke="${stroke}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;

const pine = (x: number, base: number, h: number, fill: string) =>
  `<polygon points="${x - h * 0.32},${base} ${x},${base - h} ${x + h * 0.32},${base}" fill="${fill}"/>`;

function scallops(y: number, r: number, offset: number, fill: string): string {
  let d = `M${-offset},${y}`;
  for (let x = -offset; x < COVER_W + r * 2; x += r * 2) {
    d += ` a${r},${r} 0 0,1 ${r * 2},0`;
  }
  return `<path d="${d} V${COVER_H} H${-offset}Z" fill="${fill}"/>`;
}

const stars = (fill: string) =>
  repeat(
    14,
    (i) =>
      `<circle cx="${(i * 233 + 90) % COVER_W}" cy="${50 + ((i * 97) % 170)}" r="${i % 3 === 0 ? 5 : 3.5}" fill="${fill}"/>`,
  );

const SCENES: Record<AnimalFamily, (p: AnimalPalette, far: string) => string> =
  {
    ember: (p, far) =>
      `<circle cx="1180" cy="250" r="128" fill="${p.accent}"/>${cloud(250, 120, 230, p.light)}${cloud(1380, 96, 160, p.light)}<path d="M0,330 Q260,200 560,300 T1120,300 T1600,250 V533 H0Z" fill="${far}"/><path d="M0,410 Q300,300 640,380 T1260,360 T1600,330 V533 H0Z" fill="${p.main}"/><path d="M0,470 Q420,400 820,450 T1600,420 V533 H0Z" fill="${p.dark}"/>${repeat(5, (i) => pine(985 + i * 90, 452 - i * 6, 60, p.eye))}${bird(760, 170, 22, p.eye)}${bird(830, 140, 16, p.eye)}`,
    owl: (p, far) =>
      `${stars(p.light)}<circle cx="1160" cy="210" r="120" fill="${p.light}"/><circle cx="1160" cy="210" r="120" fill="none" stroke="${p.accent}" stroke-width="14"/><path d="M0,380 Q400,300 800,360 T1600,330 V533 H0Z" fill="${far}"/>${repeat(9, (i) => pine(480 + i * 130, 470, 150 + (i % 3) * 40, i % 2 ? p.main : p.dark))}<rect y="460" width="${COVER_W}" height="73" fill="${p.dark}"/>`,
    moss: (p, far) =>
      `<circle cx="1240" cy="190" r="110" fill="${p.accent}"/>${cloud(300, 110, 220, p.light)}${cloud(820, 70, 160, p.light)}<path d="M0,450 Q500,400 1000,430 T1600,400 V533 H0Z" fill="${far}"/><path d="M380,330 Q900,250 1600,300" fill="none" stroke="${p.dark}" stroke-width="22" stroke-linecap="round"/><path d="M1020,282 Q1100,200 1180,180" fill="none" stroke="${p.dark}" stroke-width="14" stroke-linecap="round"/>${repeat(7, (i) => `<ellipse cx="${520 + i * 150}" cy="${i % 2 ? 350 : 262}" rx="56" ry="22" transform="rotate(${i % 2 ? 28 : -28} ${520 + i * 150} ${i % 2 ? 350 : 262})" fill="${i % 3 === 2 ? p.light : p.main}"/>`)}`,
    prism: (p, far) =>
      `<circle cx="1220" cy="150" r="80" fill="${p.accent}"/>${stars(p.light)}${repeat(
        8,
        (i) => {
          const x = 360 + i * 160;
          const top = 300 - (i % 3) * 50;
          return `<rect x="${x}" y="${top}" width="140" height="${COVER_H - top}" fill="${i % 2 ? p.main : far}"/><polygon points="${x - 14},${top} ${x + 70},${top - 70} ${x + 154},${top}" fill="${p.dark}"/><rect x="${x + 50}" y="${top + 40}" width="40" height="50" fill="${i % 3 === 1 ? p.accent : p.light}"/>`;
        },
      )}<rect y="480" width="${COVER_W}" height="53" fill="${p.eye}"/>`,
    cobalt: (p, far) =>
      `<circle cx="1220" cy="270" r="150" fill="${p.light}"/><circle cx="1220" cy="270" r="96" fill="${p.accent}"/>${cloud(300, 110, 200, p.light)}${scallops(330, 80, 40, far)}${scallops(390, 70, 0, p.main)}${scallops(450, 60, 30, p.dark)}${scallops(505, 50, 0, p.eye)}`,
    echo: (p, far) =>
      `${stars(p.light)}<circle cx="1180" cy="180" r="100" fill="${p.light}"/><circle cx="1225" cy="155" r="88" fill="${p.bg}"/><path d="M0,340 L1600,290 V533 H0Z" fill="${far}"/><path d="M0,400 L1600,360 V533 H0Z" fill="${p.main}"/><path d="M0,460 L1600,430 V533 H0Z" fill="${p.dark}"/>${repeat(6, (i) => `<rect x="${380 + i * 200}" y="${352 - i * 8}" width="120" height="10" rx="5" fill="${p.accent}"/>`)}${bird(780, 160, 26, p.eye)}${bird(870, 120, 18, p.eye)}`,
    atlas: (p, far) =>
      `<circle cx="420" cy="170" r="90" fill="${p.accent}"/><polygon points="520,533 900,120 1280,533" fill="${far}"/><polygon points="830,197 900,120 970,197 935,180 900,205 865,180" fill="${p.light}"/><polygon points="980,533 1260,200 1540,533" fill="${p.main}"/><polygon points="1205,265 1260,200 1315,265 1285,250 1260,272 1235,250" fill="${p.light}"/><polygon points="200,533 640,260 1080,533" fill="${p.dark}"/><polygon points="1250,533 1500,330 1750,533" fill="${p.dark}"/><rect y="480" width="${COVER_W}" height="53" fill="${p.eye}"/>${cloud(1060, 80, 190, p.light)}`,
    pebble: (p, far) =>
      `<circle cx="1300" cy="160" r="90" fill="${p.accent}"/>${cloud(240, 100, 200, p.light)}<polygon points="300,533 860,150 1420,533" fill="${far}"/><polygon points="780,205 860,150 940,205" fill="${p.light}"/>${repeat(12, (i) => pine(320 + i * 115, 500, 170 + (i % 4) * 30, i % 2 ? p.main : p.dark))}<rect y="490" width="${COVER_W}" height="43" fill="${p.eye}"/>`,
    flint: (p, far) =>
      `<circle cx="1200" cy="200" r="110" fill="${p.accent}"/>${cloud(320, 100, 220, p.light)}${cloud(860, 140, 150, p.light)}<path d="M0,360 Q400,260 800,330 T1600,300 V533 H0Z" fill="${far}"/>${repeat(5, (i) => `<circle cx="${520 + i * 230}" cy="${410 - (i % 2) * 20}" r="${70 + (i % 3) * 15}" fill="${p.main}"/>`)}<path d="M0,450 Q500,400 1000,440 T1600,420 V533 H0Z" fill="${p.dark}"/>${repeat(12, (i) => `<circle cx="${420 + i * 100}" cy="${470 + (i % 3) * 14}" r="9" fill="${i % 2 ? p.light : p.accent}"/>`)}`,
    sage: (p, far) =>
      `<circle cx="1260" cy="150" r="90" fill="${p.accent}"/>${cloud(320, 90, 220, p.light)}<path d="M0,300 Q800,250 1600,290 V533 H0Z" fill="${far}"/><ellipse cx="1000" cy="440" rx="820" ry="150" fill="${p.main}"/>${repeat(
        6,
        (i) => {
          const x = 520 + i * 170;
          const y = 400 + (i % 3) * 40;
          return `<path d="M${x},${y} L${x + 62},${y - 6} A64,22 0 1,0 ${x + 62},${y + 6} Z" fill="${i % 2 ? p.light : p.dark}"/>`;
        },
      )}${repeat(5, (i) => `<rect x="${1340 + i * 40}" y="${200 + (i % 2) * 40}" width="10" height="${260 - (i % 2) * 40}" rx="5" fill="${p.dark}"/><ellipse cx="${1345 + i * 40}" cy="${200 + (i % 2) * 40}" rx="12" ry="30" fill="${p.eye}"/>`)}`,
    nova: (p, far) =>
      `${stars(p.light)}<circle cx="1120" cy="260" r="210" fill="${far}"/><circle cx="1120" cy="260" r="140" fill="${p.light}"/><circle cx="1120" cy="260" r="80" fill="${p.accent}"/><path d="M0,440 Q500,380 1000,420 T1600,400 V533 H0Z" fill="${p.main}"/><rect y="490" width="${COVER_W}" height="43" fill="${p.dark}"/>${repeat(4, (i) => `<circle cx="${700 + i * 60}" cy="${200 + (i % 2) * 50}" r="6" fill="${p.eye}"/>`)}`,
    orbit: (p, far) =>
      `${cloud(300, 100, 220, p.light)}${cloud(1380, 80, 150, p.light)}<circle cx="1150" cy="300" r="150" fill="${p.accent}"/><rect y="300" width="${COVER_W}" height="233" fill="${far}"/>${scallops(360, 60, 20, p.main)}${scallops(430, 55, 0, p.dark)}${scallops(495, 50, 30, p.eye)}<path d="M700,345 L716,318 L684,296 L720,306 L756,296 L724,318 L740,345 Z" fill="${p.dark}"/>`,
  };

const avatarSvgCache = new Map<CharacterName, string>();
const coverSvgCache = new Map<CharacterName, string>();

function resolveCharacter(rawName: string): CharacterName {
  const normalized = rawName.replace(/^@/, "").trim().toLowerCase();
  const named = CHARACTER_NAMES.indexOf(normalized as CharacterName);
  if (named >= 0) return CHARACTER_NAMES[named];
  let seed = 2166136261;
  for (const c of normalized || "atlas") {
    seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  }
  return CHARACTER_NAMES[(seed >>> 8) % CHARACTER_NAMES.length];
}

/**
 * Returns Loop's exact deterministic Charley-Harper animal avatar SVG and
 * coordinated habitat cover banner SVG for any agent or profile name.
 */
export function getAgentArt(name: string): {
  character: CharacterName;
  palette: AnimalPalette;
  avatarSvg: string;
  coverSvg: string;
} {
  const character = resolveCharacter(name);
  const family = CHARACTERS[character];
  const palette = paletteByCharacter.get(character)!;
  const variant = familyVariantIndex.get(character) ?? 0;

  let avatarSvg = avatarSvgCache.get(character);
  if (!avatarSvg) {
    avatarSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${palette.bg}"/>${renderAnimalBody(family, palette, variant)}</svg>`;
    avatarSvgCache.set(character, avatarSvg);
  }

  let coverSvg = coverSvgCache.get(character);
  if (!coverSvg) {
    const far = mix(palette.bg, palette.main, 0.45);
    coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${COVER_W} ${COVER_H}" preserveAspectRatio="xMidYMid slice"><rect width="${COVER_W}" height="${COVER_H}" fill="${palette.bg}"/>${SCENES[family](palette, far)}</svg>`;
    coverSvgCache.set(character, coverSvg);
  }

  return { character, palette, avatarSvg, coverSvg };
}
