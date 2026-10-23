import type { CSSProperties } from "react";
import type { Provider } from "../shared/types";

import { agentAppearance } from "./agentAppearance";

export { agentAppearance as avatarIdentity } from "./agentAppearance";

export function Avatar({
  name = "Loop",
  className = "",
}: {
  name?: string;
  className?: string;
  provider?: Provider;
}) {
  const { character, background } = agentAppearance(name);
  return (
    <span
      className={`avatar avatar-3d ${className}`.trim()}
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
