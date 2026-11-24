// Shared colours for the animal avatars and their profile covers.
// scripts/generate-animal-avatars.mjs draws the avatar SVGs from these, so a
// cover always uses the colours of the avatar it sits behind.

export type AnimalPalette = {
  bg: string;
  main: string;
  dark: string;
  light: string;
  accent: string;
  eye: string;
};

// 9 curated mid-century mineral/botanical colorways (warm, earthy, crisp at 24px)
export const PALETTES: readonly AnimalPalette[] = [
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

const WIDTH = 1600;
const HEIGHT = 533;

function mix(from: string, to: string, amount: number) {
  const channel = (color: string, index: number) =>
    parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
  return (
    "#" +
    [0, 1, 2]
      .map((index) =>
        Math.round(
          channel(from, index) +
            (channel(to, index) - channel(from, index)) * amount,
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

function repeat(count: number, draw: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => draw(index)).join("");
}

const cloud = (x: number, y: number, width: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="${width}" height="30" rx="15" fill="${fill}"/>`;

const bird = (x: number, y: number, size: number, stroke: string) =>
  `<path d="M${x},${y} l${size},${size * 0.6} l${size},${-size * 0.6}" fill="none" stroke="${stroke}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;

const pine = (x: number, base: number, height: number, fill: string) =>
  `<polygon points="${x - height * 0.32},${base} ${x},${base - height} ${x + height * 0.32},${base}" fill="${fill}"/>`;

function scallops(y: number, radius: number, offset: number, fill: string) {
  let path = `M${-offset},${y}`;
  for (let x = -offset; x < WIDTH + radius * 2; x += radius * 2)
    path += ` a${radius},${radius} 0 0,1 ${radius * 2},0`;
  return `<path d="${path} V${HEIGHT} H${-offset}Z" fill="${fill}"/>`;
}

const stars = (fill: string) =>
  repeat(
    14,
    (index) =>
      `<circle cx="${(index * 233 + 90) % WIDTH}" cy="${50 + ((index * 97) % 170)}" r="${index % 3 === 0 ? 5 : 3.5}" fill="${fill}"/>`,
  );

// Each family's habitat, drawn with the avatar's flat fills and hard edges.
// Focal shapes sit right of centre: the avatar covers the lower left.
const scenes: Record<AnimalFamily, (p: AnimalPalette, far: string) => string> =
  {
    // Fox: autumn hills
    ember: (p, far) =>
      `<circle cx="1180" cy="250" r="128" fill="${p.accent}"/>${cloud(250, 120, 230, p.light)}${cloud(1380, 96, 160, p.light)}<path d="M0,330 Q260,200 560,300 T1120,300 T1600,250 V533 H0Z" fill="${far}"/><path d="M0,410 Q300,300 640,380 T1260,360 T1600,330 V533 H0Z" fill="${p.main}"/><path d="M0,470 Q420,400 820,450 T1600,420 V533 H0Z" fill="${p.dark}"/>${repeat(5, (index) => pine(985 + index * 90, 452 - index * 6, 60, p.eye))}${bird(760, 170, 22, p.eye)}${bird(830, 140, 16, p.eye)}`,
    // Owl: moonlit pines
    owl: (p, far) =>
      `${stars(p.light)}<circle cx="1160" cy="210" r="120" fill="${p.light}"/><circle cx="1160" cy="210" r="120" fill="none" stroke="${p.accent}" stroke-width="14"/><path d="M0,380 Q400,300 800,360 T1600,330 V533 H0Z" fill="${far}"/>${repeat(9, (index) => pine(480 + index * 130, 470, 150 + (index % 3) * 40, index % 2 ? p.main : p.dark))}<rect y="460" width="${WIDTH}" height="73" fill="${p.dark}"/>`,
    // Songbird: a leafy branch
    moss: (p, far) =>
      `<circle cx="1240" cy="190" r="110" fill="${p.accent}"/>${cloud(300, 110, 220, p.light)}${cloud(820, 70, 160, p.light)}<path d="M0,450 Q500,400 1000,430 T1600,400 V533 H0Z" fill="${far}"/><path d="M380,330 Q900,250 1600,300" fill="none" stroke="${p.dark}" stroke-width="22" stroke-linecap="round"/><path d="M1020,282 Q1100,200 1180,180" fill="none" stroke="${p.dark}" stroke-width="14" stroke-linecap="round"/>${repeat(
        7,
        (index) =>
          `<ellipse cx="${520 + index * 150}" cy="${index % 2 ? 350 : 262}" rx="56" ry="22" transform="rotate(${index % 2 ? 28 : -28} ${520 + index * 150} ${index % 2 ? 350 : 262})" fill="${index % 3 === 2 ? p.light : p.main}"/>`,
      )}`,
    // Cat: rooftops
    prism: (p, far) =>
      `<circle cx="1220" cy="150" r="80" fill="${p.accent}"/>${stars(p.light)}${repeat(
        8,
        (index) => {
          const x = 360 + index * 160;
          const top = 300 - (index % 3) * 50;
          return `<rect x="${x}" y="${top}" width="140" height="${HEIGHT - top}" fill="${index % 2 ? p.main : far}"/><polygon points="${x - 14},${top} ${x + 70},${top - 70} ${x + 154},${top}" fill="${p.dark}"/><rect x="${x + 50}" y="${top + 40}" width="40" height="50" fill="${index % 3 === 1 ? p.accent : p.light}"/>`;
        },
      )}<rect y="480" width="${WIDTH}" height="53" fill="${p.eye}"/>`,
    // Otter: river waves
    cobalt: (p, far) =>
      `<circle cx="1220" cy="270" r="150" fill="${p.light}"/><circle cx="1220" cy="270" r="96" fill="${p.accent}"/>${cloud(300, 110, 200, p.light)}${scallops(330, 80, 40, far)}${scallops(390, 70, 0, p.main)}${scallops(450, 60, 30, p.dark)}${scallops(505, 50, 0, p.eye)}`,
    // Raven: crescent moon over fields
    echo: (p, far) =>
      `${stars(p.light)}<circle cx="1180" cy="180" r="100" fill="${p.light}"/><circle cx="1225" cy="155" r="88" fill="${p.bg}"/><path d="M0,340 L1600,290 V533 H0Z" fill="${far}"/><path d="M0,400 L1600,360 V533 H0Z" fill="${p.main}"/><path d="M0,460 L1600,430 V533 H0Z" fill="${p.dark}"/>${repeat(6, (index) => `<rect x="${380 + index * 200}" y="${352 - index * 8}" width="120" height="10" rx="5" fill="${p.accent}"/>`)}${bird(780, 160, 26, p.eye)}${bird(870, 120, 18, p.eye)}`,
    // Eagle: snow-capped peaks
    atlas: (p, far) =>
      `<circle cx="420" cy="170" r="90" fill="${p.accent}"/><polygon points="520,533 900,120 1280,533" fill="${far}"/><polygon points="830,197 900,120 970,197 935,180 900,205 865,180" fill="${p.light}"/><polygon points="980,533 1260,200 1540,533" fill="${p.main}"/><polygon points="1205,265 1260,200 1315,265 1285,250 1260,272 1235,250" fill="${p.light}"/><polygon points="200,533 640,260 1080,533" fill="${p.dark}"/><polygon points="1250,533 1500,330 1750,533" fill="${p.dark}"/><rect y="480" width="${WIDTH}" height="53" fill="${p.eye}"/>${cloud(1060, 80, 190, p.light)}`,
    // Bear: pine forest under a mountain
    pebble: (p, far) =>
      `<circle cx="1300" cy="160" r="90" fill="${p.accent}"/>${cloud(240, 100, 200, p.light)}<polygon points="300,533 860,150 1420,533" fill="${far}"/><polygon points="780,205 860,150 940,205" fill="${p.light}"/>${repeat(12, (index) => pine(320 + index * 115, 500, 170 + (index % 4) * 30, index % 2 ? p.main : p.dark))}<rect y="490" width="${WIDTH}" height="43" fill="${p.eye}"/>`,
    // Hare: meadow with bushes and flowers
    flint: (p, far) =>
      `<circle cx="1200" cy="200" r="110" fill="${p.accent}"/>${cloud(320, 100, 220, p.light)}${cloud(860, 140, 150, p.light)}<path d="M0,360 Q400,260 800,330 T1600,300 V533 H0Z" fill="${far}"/>${repeat(5, (index) => `<circle cx="${520 + index * 230}" cy="${410 - (index % 2) * 20}" r="${70 + (index % 3) * 15}" fill="${p.main}"/>`)}<path d="M0,450 Q500,400 1000,440 T1600,420 V533 H0Z" fill="${p.dark}"/>${repeat(12, (index) => `<circle cx="${420 + index * 100}" cy="${470 + (index % 3) * 14}" r="9" fill="${index % 2 ? p.light : p.accent}"/>`)}`,
    // Frog: pond with lily pads and reeds
    sage: (p, far) =>
      `<circle cx="1260" cy="150" r="90" fill="${p.accent}"/>${cloud(320, 90, 220, p.light)}<path d="M0,300 Q800,250 1600,290 V533 H0Z" fill="${far}"/><ellipse cx="1000" cy="440" rx="820" ry="150" fill="${p.main}"/>${repeat(
        6,
        (index) => {
          const x = 520 + index * 170;
          const y = 400 + (index % 3) * 40;
          return `<path d="M${x},${y} L${x + 62},${y - 6} A64,22 0 1,0 ${x + 62},${y + 6} Z" fill="${index % 2 ? p.light : p.dark}"/>`;
        },
      )}${repeat(5, (index) => `<rect x="${1340 + index * 40}" y="${200 + (index % 2) * 40}" width="10" height="${260 - (index % 2) * 40}" rx="5" fill="${p.dark}"/><ellipse cx="${1345 + index * 40}" cy="${200 + (index % 2) * 40}" rx="12" ry="30" fill="${p.eye}"/>`)}`,
    // Moth: lamp glow in a starry night
    nova: (p, far) =>
      `${stars(p.light)}<circle cx="1120" cy="260" r="210" fill="${far}"/><circle cx="1120" cy="260" r="140" fill="${p.light}"/><circle cx="1120" cy="260" r="80" fill="${p.accent}"/><path d="M0,440 Q500,380 1000,420 T1600,400 V533 H0Z" fill="${p.main}"/><rect y="490" width="${WIDTH}" height="43" fill="${p.dark}"/>${repeat(4, (index) => `<circle cx="${700 + index * 60}" cy="${200 + (index % 2) * 50}" r="6" fill="${p.eye}"/>`)}`,
    // Whale: open sea with the sun on the horizon
    orbit: (p, far) =>
      `${cloud(300, 100, 220, p.light)}${cloud(1380, 80, 150, p.light)}<circle cx="1150" cy="300" r="150" fill="${p.accent}"/><rect y="300" width="${WIDTH}" height="233" fill="${far}"/>${scallops(360, 60, 20, p.main)}${scallops(430, 55, 0, p.dark)}${scallops(495, 50, 30, p.eye)}<path d="M700,345 L716,318 L684,296 L720,306 L756,296 L724,318 L740,345 Z" fill="${p.dark}"/>`,
  };

/** A flat SVG landscape for one family, in one of the avatar palettes. */
export function profileCoverSvg(family: AnimalFamily, palette: AnimalPalette) {
  const far = mix(palette.bg, palette.main, 0.45);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.bg}"/>${scenes[family](palette, far)}</svg>`;
}
