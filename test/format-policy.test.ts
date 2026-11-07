import { existsSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps source formatting free of repository ignore exceptions", () => {
  expect(existsSync(new URL("../.prettierignore", import.meta.url))).toBe(
    false,
  );
});
