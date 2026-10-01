import { expect, it } from "vitest";
import { leftoverPan } from "../src/client/Pwa";

it("folds a pan Safari leaves after the keyboard closes back into the page", () => {
  // Keyboard closed, but the visible area is still panned 240px down: the
  // fixed composer and tabs would sit 240px above the bottom of the screen.
  expect(leftoverPan({ offsetTop: 240, scale: 1 }, false)).toBe(240);
  // Nothing to fix when the view is not panned.
  expect(leftoverPan({ offsetTop: 0, scale: 1 }, false)).toBe(0);
  expect(leftoverPan({ offsetTop: 0.4, scale: 1 }, false)).toBe(0);
  // While typing, Safari pans to keep the field visible; leave it.
  expect(leftoverPan({ offsetTop: 240, scale: 1 }, true)).toBe(0);
  // Pinch zoom pans on purpose; leave it.
  expect(leftoverPan({ offsetTop: 240, scale: 2 }, false)).toBe(0);
  expect(leftoverPan(undefined, false)).toBe(0);
});
