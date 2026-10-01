import { beforeEach, expect, it } from "vitest";
import {
  cacheView,
  cachedView,
  setViewOwner,
  viewOwner,
} from "../src/client/viewCache";

beforeEach(() => setViewOwner(undefined));

it("returns a page as you left it, only to the account that saw it", () => {
  setViewOwner("alice");
  cacheView("search", { query: "private plans" }, "alice");
  expect(cachedView("search")).toEqual({ query: "private plans" });
  // Signing out or switching account drops every cached view.
  setViewOwner(undefined);
  expect(cachedView("search")).toBeUndefined();
  cacheView("search", { query: "while signed out" }, undefined);
  setViewOwner("bob");
  expect(cachedView("search")).toBeUndefined();
  setViewOwner("alice");
  expect(cachedView("search")).toBeUndefined();
});

it("drops a response that arrives after the account changed", () => {
  // Alice's Later request starts; it records whom it is for.
  setViewOwner("alice");
  const requestedFor = viewOwner();
  // Her session expires and Bob signs in before her response arrives.
  setViewOwner(undefined);
  setViewOwner("bob");
  // Alice's late response must not become part of Bob's views.
  cacheView("later:[]", { later: ["Alice's private thread"] }, requestedFor);
  expect(cachedView("later:[]")).toBeUndefined();
  // Bob's own response is cached for Bob.
  cacheView("later:[]", { later: [] }, viewOwner());
  expect(cachedView("later:[]")).toEqual({ later: [] });
});

it("keeps a bounded number of views, replacing the oldest first", () => {
  setViewOwner("alice");
  for (let i = 0; i < 41; i++) cacheView("view-" + i, i, "alice");
  expect(cachedView("view-0")).toBeUndefined();
  expect(cachedView("view-1")).toBe(1);
  expect(cachedView("view-40")).toBe(40);
});
