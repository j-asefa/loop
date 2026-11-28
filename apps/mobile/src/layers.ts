/**
 * Stacking order for views App renders as absolutely positioned siblings.
 * The tab dock floats above the screens, so every full-screen overlay must
 * sit above it or the dock covers the overlay's lower part.
 */
export const LAYERS = {
  tabDock: 15,
  compose: 50,
  pairing: 60,
  toast: 70,
} as const;
