// Bounded samples after a keyboard/focus signal; no polling while idle.
export const SHEET_SETTLE_MS = [100, 300, 600, 1000, 1500] as const;

/** Visible top in the client coordinates used by DOMRects and hit testing.
 * Safari can repeat the keyboard's page scroll in offsetTop: the captured
 * pageTop=337, scrollY=337, offsetTop=337 means visible top 0, not 337.
 * Subtract the document scroll once; clamp transitional negative readings. */
export function visibleViewportTop(
  viewport: { pageTop?: number; offsetTop: number },
  scrollY: number,
) {
  return Math.max(
    0,
    Number.isFinite(viewport.pageTop)
      ? viewport.pageTop! - scrollY
      : viewport.offsetTop,
  );
}
