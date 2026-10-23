import { agentAppearance } from "./agentAppearance";

/** Personal and agent profile covers coordinate with their avatar. */
export function ProfileCover({ name }: { name?: string }) {
  const src =
    name === undefined ? "/profile-cover.webp" : agentAppearance(name).cover;
  return (
    <div className="profile-cover" aria-hidden="true">
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
    </div>
  );
}
