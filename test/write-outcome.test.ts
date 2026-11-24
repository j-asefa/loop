import { describe, expect, it } from "vitest";
import { writeOutcome } from "../src/client/writeOutcome";

const failure = (status?: number, executionOutcome?: string) =>
  Object.assign(
    new Error("Request failed"),
    status ? { status } : {},
    executionOutcome ? { executionOutcome } : {},
  );

describe("writeOutcome", () => {
  it("treats a client error as a refusal, so a shown change is undone", () => {
    for (const status of [400, 403, 404, 409, 422])
      expect(writeOutcome(failure(status))).toBe("refused");
  });

  it("leaves no answer, timeouts, rate limits and server errors uncertain", () => {
    expect(writeOutcome(failure())).toBe("uncertain");
    expect(writeOutcome(new TypeError("Failed to fetch"))).toBe("uncertain");
    for (const status of [408, 429, 500, 502, 503])
      expect(writeOutcome(failure(status))).toBe("uncertain");
    expect(writeOutcome(null)).toBe("uncertain");
    expect(writeOutcome("offline")).toBe("uncertain");
  });

  it("lets the server's explicit execution outcome decide before the status", () => {
    // A remote source answers 503 for a write it completed: never resend it.
    expect(writeOutcome(failure(503, "completed"))).toBe("applied");
    // And 409 for a write whose outcome it does not know.
    expect(writeOutcome(failure(409, "unknown"))).toBe("uncertain");
    expect(writeOutcome(failure(503, "refused"))).toBe("refused");
  });
});
