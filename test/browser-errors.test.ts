import { describe, expect, it } from "vitest";
// @ts-expect-error Plain JavaScript helper used by browser smoke scripts.
import { isWebKitNavigationFetchError } from "../scripts/helpers/browser-errors.mjs";

const base = "http://127.0.0.1:34093";
const diagnostic = `Fetch API cannot load ${base}/api/agents/123/messages due to access control checks.`;
describe("WebKit navigation fetch diagnostic", () => {
  it("recognizes the full and Playwright-shortened diagnostic", () => {
    expect(
      isWebKitNavigationFetchError("webkit", { message: diagnostic }, base),
    ).toBe(true);
    expect(
      isWebKitNavigationFetchError(
        "webkit",
        {
          message:
            "/127.0.0.1:34093/api/agents/123/messages due to access control checks.",
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
