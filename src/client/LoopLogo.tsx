// The installed app icon is also Loop’s shared in-app brand mark.
export function LoopLogo({
  size = 27,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/icon-192.png"
      width={size}
      height={size}
      className={`loop-logo ${className}`.trim()}
      alt=""
      aria-hidden="true"
    />
  );
}
