import { expect, it } from "vitest";
import { reviewDelta } from "../src/server/review-delta";

const file = (path: string, index: string, hunks: string) =>
  `diff --git a/${path} b/${path}\nindex ${index}\n--- a/${path}\n+++ b/${path}\n${hunks}`;

it("treats a rebased diff as already reviewed and reports only lines the reviewed diff lacked", () => {
  const reviewed = file(
    "a.ts",
    "111..222 100644",
    "@@ -1,3 +1,4 @@\n one\n+two\n three\n-four\n",
  );
  // Same change after a rebase: new blob ids, shifted hunk and other context.
  const rebased = file(
    "a.ts",
    "333..444 100644",
    "@@ -10,3 +10,4 @@\n zero\n+two\n three\n-four\n",
  );
  expect(reviewDelta(rebased, reviewed)).toEqual({
    changed: 2,
    unseen: 0,
    hunks: "",
  });

  const edited =
    file(
      "a.ts",
      "333..555 100644",
      "@@ -10,3 +10,5 @@\n zero\n+two\n+two\n three\n-four\n",
    ) + file("b.ts", "000..666 100644", "@@ -0,0 +1 @@\n+two\n");
  const delta = reviewDelta(edited, reviewed);
  // The repeated line is new once, and the same text in another file is new.
  expect(delta).toMatchObject({ changed: 4, unseen: 2 });
  expect(delta.hunks).toContain("diff --git a/a.ts b/a.ts");
  expect(delta.hunks).toContain("diff --git a/b.ts b/b.ts");
});

it("counts a change without hunks once and excerpts long hunks around new lines", () => {
  const binary =
    "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n";
  expect(reviewDelta(binary, "")).toMatchObject({ changed: 1, unseen: 1 });
  expect(reviewDelta(binary, binary)).toMatchObject({ changed: 1, unseen: 0 });

  const lines = Array.from({ length: 40 }, (_, i) => `+line ${i}`);
  const before = file(
    "new.ts",
    "0..1",
    "@@ -0,0 +1,40 @@\n" + lines.join("\n"),
  );
  const after = file(
    "new.ts",
    "0..2",
    "@@ -0,0 +1,40 @@\n" + lines.with(20, "+line twenty").join("\n"),
  );
  const delta = reviewDelta(after, before);
  expect(delta).toMatchObject({ changed: 40, unseen: 1 });
  expect(delta.hunks).toContain("+line twenty");
  expect(delta.hunks).toContain("+line 17");
  expect(delta.hunks).not.toContain("+line 5\n");
  expect(delta.hunks).toContain("[…]");
});
