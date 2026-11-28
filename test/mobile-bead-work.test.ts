import { expect, it, vi } from "vitest";
import {
  beadDraftScope,
  prepareBeadComment,
  workPageIndex,
  workSelection,
} from "../apps/mobile/src/bead-work-state";

it("posts the highlighted passage to the original target after Spotlight pages and data reorder", () => {
  const origin = { projectId: "project", storeId: "store", beadId: "loop-one" };
  const other = { ...origin, beadId: "loop-two" };
  const newRequestId = vi.fn(() => "original-request");
  const excerpt = workSelection("First\nExact passage\nLast", 6, 19);
  const attempt = prepareBeadComment(
    origin,
    { excerpt, text: "Please verify" },
    newRequestId,
  );

  expect(
    workPageIndex([{ id: other.beadId }, { id: origin.beadId }], origin.beadId),
  ).toBe(1);
  expect(beadDraftScope(other)).not.toBe(attempt.scope);
  expect(attempt.target).toBe(origin);
  expect(attempt.draft).toEqual({
    text: "Please verify",
    excerpt: "Exact passage",
    requestId: "original-request",
  });
  const reloaded = JSON.parse(JSON.stringify(attempt.draft));
  expect(prepareBeadComment(origin, reloaded, newRequestId)).toEqual(attempt);
  expect(newRequestId).toHaveBeenCalledOnce();
});
