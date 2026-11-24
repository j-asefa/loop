import { describe, expect, it } from "vitest";
import { refusedWrite } from "../src/client/writeOutcome";

const failure = (status?: number) =>
  Object.assign(new Error("Request failed"), status ? { status } : {});

describe("refusedWrite", () => {
  it("treats a client error as a refusal, so a shown change is undone", () => {
    for (const status of [400, 403, 404, 409, 422])
      expect(refusedWrite(failure(status))).toBe(true);
  });

  it("leaves no answer, timeouts, rate limits and server errors uncertain", () => {
    expect(refusedWrite(failure())).toBe(false);
    expect(refusedWrite(new TypeError("Failed to fetch"))).toBe(false);
    for (const status of [408, 429, 500, 502, 503])
      expect(refusedWrite(failure(status))).toBe(false);
    expect(refusedWrite(null)).toBe(false);
    expect(refusedWrite("offline")).toBe(false);
  });
});
