import { FAMILY_OFFSET, PALETTES, profileCoverSvg } from "./animalArt";

// Character order defines deterministic avatar, backdrop and cover assignments.
const characters = {
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
} as const;

type AgentCharacter = keyof typeof characters;
const names = Object.keys(characters) as AgentCharacter[];
const backdrops = [
  "#d8b544",
  "#a6b39c",
  "#bac2a6",
  "#c6b17f",
  "#a6b9b8",
  "#b8adb7",
  "#b8b4a7",
  "#c6ad92",
];

// Each family has one scene; a character draws it in its own avatar palette.
const familySize = new Map<string, number>();
const paletteIndex = new Map<AgentCharacter, number>();
for (const character of names) {
  const family = characters[character];
  const index = familySize.get(family) ?? 0;
  paletteIndex.set(
    character,
    (FAMILY_OFFSET[family] + index) % PALETTES.length,
  );
  familySize.set(family, index + 1);
}

const covers = new Map<AgentCharacter, string>();
function cover(character: AgentCharacter) {
  let source = covers.get(character);
  if (!source) {
    const svg = profileCoverSvg(
      characters[character],
      PALETTES[paletteIndex.get(character)!],
    );
    source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    covers.set(character, source);
  }
  return source;
}

/** One consistent avatar and matching cover for a name, in every view. */
export function agentAppearance(name: string) {
  const normalized = name.toLowerCase();
  let seed = 2166136261;
  for (const c of normalized)
    seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const named = names.indexOf(normalized as AgentCharacter);
  const character = names[named < 0 ? (seed >>> 8) % names.length : named];
  return {
    character,
    background: backdrops[(named < 0 ? seed >>> 16 : named) % backdrops.length],
    cover: cover(character),
  };
}
