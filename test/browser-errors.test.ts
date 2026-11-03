import { describe, expect, it } from "vitest";
// @ts-expect-error Plain JavaScript helper used by browser smoke scripts.
import { isWebKitNavigationFetchError } from "../scripts/helpers/browser-errors.mjs";

describe.each([
  "http://127.0.0.1:34093",
  "https://loop-fixture-6841.trycloudflare.com",
])("WebKit navigation fetch diagnostic for %s", (base) => {
  const diagnostic = `Fetch API cannot load ${base}/api/agents/123/messages due to access control checks.`;
  it("recognizes the full and Playwright-shortened diagnostic", () => {
    expect(
      isWebKitNavigationFetchError("webkit", { message: diagnostic }, base),
    ).toBe(true);
    expect(
      isWebKitNavigationFetchError(
        "webkit",
        {
          message: `/${new URL(base).host}/api/agents/123/messages due to access control checks.`,
          stack: `${diagnostic}\n    at fetch`,
        },
        base,
      ),
    ).toBe(true);
  });
  it("retains other engines, origins, paths and application errors", () => {
    expect(
      isWebKitNavigationFetchError("chromium", { message: diagnostic }, base),
    ).toBe(false);
    for (const message of [
      diagnostic.replace(base, "https://other.example"),
      diagnostic.replace("/api/", "/assets/"),
      "Unhandled application failure",
      `Error: application failure\n${diagnostic}`,
    ])
      expect(
        isWebKitNavigationFetchError(
          "webkit",
          { message, stack: message },
          base,
        ),
      ).toBe(false);
  });
});
