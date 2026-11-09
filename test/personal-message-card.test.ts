import { describe, expect, it } from "vitest";
import { opensContentCard } from "../src/client/ContentCard";

const control = { tag: "button" };
const card = {
  contains: (node: unknown) => node === control,
} as unknown as Element;
const target = (closest: unknown) =>
  ({ closest: () => closest }) as unknown as EventTarget;

describe("sent message card clicks", () => {
  it("opens the conversation from the card body", () => {
    expect(opensContentCard(target(null), card)).toBe(true);
  });
  it("leaves controls inside the card to their own handlers", () => {
    expect(opensContentCard(target(control), card)).toBe(false);
  });
  it("does not navigate while the user is selecting text", () => {
    expect(opensContentCard(target(null), card, "PR")).toBe(false);
  });
});
