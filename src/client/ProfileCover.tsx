/** Shared decorative cover; fixed dimensions avoid shifting the profile as it loads. */
export function ProfileCover() {
  return (
    <div className="profile-cover" aria-hidden="true">
      <img
        src="/profile-cover.webp"
        alt=""
        width="1600"
        height="533"
        decoding="async"
        draggable={false}
      />
    </div>
  );
}
