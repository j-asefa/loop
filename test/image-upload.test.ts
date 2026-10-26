import { expect, it } from "vitest";
import {
  fitWithin,
  MAX_EDGE,
  REENCODE_ABOVE_BYTES,
  shouldPrepare,
  sendConverted,
} from "../src/client/imageUpload";

it("scales an image so its longest side fits, keeping its shape", () => {
  expect(fitWithin(4032, 3024)).toEqual({ width: MAX_EDGE, height: 1536 });
  expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: MAX_EDGE });
  // Never upscales.
  expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  expect(fitWithin(10_000, 1)).toEqual({ width: MAX_EDGE, height: 1 });
});

it("prepares large or HEIC photos and leaves everything else alone", () => {
  const big = REENCODE_ABOVE_BYTES + 1;
  expect(
    shouldPrepare({ type: "image/jpeg", size: big, name: "IMG_1.jpg" }),
  ).toBe(true);
  expect(
    shouldPrepare({ type: "image/heic", size: 1000, name: "IMG_1.HEIC" }),
  ).toBe(true);
  // Some pickers report no type for HEIC; the name still counts.
  expect(shouldPrepare({ type: "", size: 1000, name: "IMG_1.heif" })).toBe(
    true,
  );
  expect(
    shouldPrepare({ type: "image/png", size: 200_000, name: "shot.png" }),
  ).toBe(false);
  // Animated GIFs and SVGs would lose what makes them what they are.
  expect(shouldPrepare({ type: "image/gif", size: big, name: "a.gif" })).toBe(
    false,
  );
  expect(
    shouldPrepare({ type: "image/svg+xml", size: big, name: "a.svg" }),
  ).toBe(false);
  expect(
    shouldPrepare({ type: "application/pdf", size: big, name: "a.pdf" }),
  ).toBe(false);
});

it("sends the JPEG when it is smaller, and always for HEIC", () => {
  const png = { type: "image/png", size: 2_000_000, name: "shot.png" };
  expect(sendConverted(png, 400_000)).toBe(true);
  expect(sendConverted(png, 2_000_000)).toBe(false);
  // A HEIC is converted even when the JPEG is larger, whether the picker
  // reports its type or only its name.
  expect(
    sendConverted(
      { type: "image/heic", size: 300_000, name: "IMG_1.HEIC" },
      500_000,
    ),
  ).toBe(true);
  expect(
    sendConverted({ type: "", size: 300_000, name: "IMG_1.heic" }, 500_000),
  ).toBe(true);
  expect(
    sendConverted({ type: "", size: 300_000, name: "IMG_1.HEIF" }, 300_000),
  ).toBe(true);
});
