import { dropSpecBlocks } from "../shared/text.js";

// Plain one-line preview. Display (`spec`) blocks are dropped first, so their
// JSON never shows in a row, even while the block is still being written.
export const collapse = (text: string | null | undefined, max: number) =>
  dropSpecBlocks(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
