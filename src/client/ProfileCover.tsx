import { useState } from "react";
import { ProfilePhoto } from "./ProfilePhoto";
import { agentAppearance } from "./agentAppearance";

/** Personal and agent profile covers coordinate with their avatar. */
export function ProfileCover({ name }: { name?: string }) {
  const [open, setOpen] = useState(false);
  const label = `${name || "Your profile"} banner`;
  const src =
    name === undefined ? "/profile-cover.webp" : agentAppearance(name).cover;
  return (
    <>
      <button
        type="button"
        className="profile-cover"
        aria-label={`View ${label}`}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        <img
          key={src}
          src={src}
          alt=""
          width="1600"
          height="533"
          decoding="async"
          draggable={false}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      </button>
      {open && (
        <ProfilePhoto src={src} label={label} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
