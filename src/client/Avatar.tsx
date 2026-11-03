import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ProfilePhoto } from "./ProfilePhoto";
import type { Provider } from "../shared/types";

import { agentAppearance } from "./agentAppearance";

export { agentAppearance as avatarIdentity } from "./agentAppearance";

export function Avatar({
  name = "Loop",
  className = "",
  expandable = false,
}: {
  name?: string;
  className?: string;
  provider?: Provider;
  expandable?: boolean;
}) {
  const { character, background } = agentAppearance(name);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (visible || !image.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // Observe clipping by the horizontal agent strip as well as the viewport.
    // Native image lazy loading alone can fetch far beyond the visible strip.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "128px" },
    );
    observer.observe(image.current);
    return () => observer.disconnect();
  }, [character, visible]);
  const Tag = expandable ? "button" : "span";
  return (
    <>
      <Tag
        className={`avatar avatar-3d ${className}`.trim()}
        type={expandable ? "button" : undefined}
        onClick={
          expandable
            ? (event) => {
                event.currentTarget.focus();
                setOpen(true);
              }
            : undefined
        }
        role={expandable ? undefined : "img"}
        aria-label={expandable ? `View ${name} avatar` : name + " avatar"}
        style={{ "--avatar-background": background } as CSSProperties}
      >
        <span className="avatar-fallback" aria-hidden="true">
          {Array.from(name.trim())[0]?.toUpperCase() || "L"}
        </span>
        <img
          key={character}
          ref={image}
          src={visible ? `/avatars/robots/${character}.webp` : undefined}
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
      </Tag>
      {open && (
        <ProfilePhoto
          src={`/avatars/robots/${character}.webp`}
          label={`${name} avatar`}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
