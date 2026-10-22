import type { CSSProperties } from "react";
import type { Provider } from "../shared/types";

const characters = [
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
] as const;
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

/** Names keep the same character everywhere, independent of provider or theme. */
export function avatarIdentity(name: string) {
  const normalized = name.toLowerCase();
  let seed = 2166136261;
  for (const c of normalized)
    seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const named = characters.findIndex((character) => character === normalized);
  return {
    character: characters[named < 0 ? (seed >>> 8) % characters.length : named],
    background: backdrops[(named < 0 ? seed >>> 16 : named) % backdrops.length],
  };
}

export function Avatar({
  name = "Loop",
}: {
  name?: string;
  provider?: Provider;
}) {
  const { character, background } = avatarIdentity(name);
  return (
    <span
      className="avatar avatar-3d"
      role="img"
      aria-label={name + " avatar"}
      style={{ "--avatar-background": background } as CSSProperties}
    >
      <span className="avatar-fallback" aria-hidden="true">
        {Array.from(name.trim())[0]?.toUpperCase() || "L"}
      </span>
      <img
        key={character}
        src={`/avatars/${character}.webp`}
        alt=""
        aria-hidden="true"
        width="384"
        height="384"
        decoding="async"
        draggable={false}
        onError={(event) => {
          event.currentTarget.hidden = true;
        }}
      />
    </span>
  );
}
