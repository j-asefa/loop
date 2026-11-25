/**
 * Slide feed cards to their new places after one opens, closes or leaves
 * (track B, D6), instead of letting them jump.
 *
 * `capture` records where each card is, in the viewport, just before the
 * change; `play` runs after React commits it (in a layout effect, before
 * paint) and animates each moved card from its old place to its new one
 * with a transform only. Nothing is measured on other renders, so refreshes,
 * scrolling and a sheet's scroll lock never start a slide.
 */
const SELECTOR = ".feed-item-wrap";
const DURATION = 240;
const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export type CardPlaces = Map<Element, number>;

export function captureCardPlaces(list: Element | null): CardPlaces {
  const places: CardPlaces = new Map();
  if (!list || reducedMotion()) return places;
  for (const card of list.querySelectorAll(SELECTOR))
    places.set(card, card.getBoundingClientRect().top);
  return places;
}

export function slideCards(places: CardPlaces) {
  for (const [card, before] of places) {
    if (!card.isConnected) continue;
    const moved = before - card.getBoundingClientRect().top;
    // Off-screen moves are not seen; skip them and sub-pixel noise.
    if (Math.abs(moved) < 1 || Math.abs(moved) > innerHeight * 2) continue;
    card.animate(
      [{ transform: `translateY(${moved}px)` }, { transform: "none" }],
      { duration: DURATION, easing: EASING },
    );
  }
}

function reducedMotion() {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
