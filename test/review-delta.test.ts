import { expect, it } from "vitest";
import { changedLines, snapshotDelta } from "../src/server/review-delta";

const body = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
const snapshot = (
  files: Record<string, string[]>,
  before: Record<string, string[]> = {},
  diff = "",
) => ({
  diff,
  omitted: [] as string[],
  changed: [...new Set([...Object.keys(files), ...Object.keys(before)])].sort(),
  files: Object.fromEntries(
    Object.entries(files).map(([path, lines]) => [path, lines.join("\n")]),
  ),
  before: Object.fromEntries(
    Object.entries(before).map(([path, lines]) => [path, lines.join("\n")]),
  ),
});

it("finds nothing new for the same edit of the same base text, and counts the whole edit when the base differs", () => {
  const reviewed = snapshot(
    { "a.ts": body(40) },
    { "a.ts": body(30) },
    "diff --git a/a.ts b/a.ts\nindex 111..222 100644\n@@ -28,3 +28,13 @@\n",
  );
  // A rebase that left this file alone: other blob ids and hunk offsets only.
  const rebased = snapshot(
    { "a.ts": body(40) },
    { "a.ts": body(30) },
    "diff --git a/a.ts b/a.ts\nindex 333..444 100644\n@@ -1,4 +1,13 @@\n",
  );
  expect(snapshotDelta(rebased, reviewed)).toEqual({ unseen: 0, hunks: "" });
  expect(changedLines(reviewed)).toBe(10);

  // The same final text against an older base is a larger change than the
  // one reviewed: all of it is new, so it cannot pass as mostly reviewed.
  const olderBase = snapshot({ "a.ts": body(40) }, { "a.ts": body(5) });
  const delta = snapshotDelta(olderBase, reviewed);
  expect(delta.unseen).toBe(35);
  expect(delta.unseen * 2 > changedLines(olderBase)).toBe(true);
});

it("counts deleted, moved and edited lines and excerpts them with their line numbers", () => {
  const reviewed = snapshot({ "a.ts": body(40) }, { "a.ts": body(10) });
  const lines = body(40);
  const guard = lines.splice(12, 1)[0];
  lines.splice(30, 0, guard);
  lines[35] = "line thirty-six";
  lines.splice(5, 1);
  const delta = snapshotDelta(
    snapshot({ "a.ts": lines }, { "a.ts": body(10) }),
    reviewed,
  );
  // One deletion, one move (a removal and an addition) and one edit (same).
  expect(delta.unseen).toBe(5);
  expect(delta.hunks).toContain("--- earlier snapshot: a.ts");
  expect(delta.hunks).toContain("-line 5");
  expect(delta.hunks).toContain("-line 12");
  expect(delta.hunks).toContain("+line 12");
  expect(delta.hunks).toContain("+line thirty-six");
  expect(delta.hunks).toContain("@@ line 3 @@");
  expect(delta.hunks).not.toContain("line 20");
});

it("counts an untracked file a captured diff lists by name only, and a file returned to its base", () => {
  const listed =
    '\nNew file: "notes.ts" (read its full contents with loop_review_read)\n';
  const reviewed = snapshot(
    { "a.ts": body(20), "notes.ts": body(50, "note") },
    { "a.ts": body(10) },
    listed,
  );
  const rewritten = snapshot({ "notes.ts": body(50, "rewritten") }, {}, listed);
  const delta = snapshotDelta(rewritten, reviewed);
  // Every line of the untracked file changed, and a.ts lost its ten new lines.
  expect(delta.unseen).toBe(110);
  expect(delta.hunks).toContain("+++ this snapshot: notes.ts");
  // The dropped file is described, not diffed against a base that may be stale.
  expect(delta.hunks).toContain("no longer changes this file: the 10 changed");
  expect(delta.hunks).not.toContain("-line 19");
  // A file that became omitted is said to be uncomparable, not gone.
  expect(
    snapshotDelta({ ...rewritten, omitted: ["a.ts"] }, reviewed).hunks,
  ).toContain("This snapshot omits this file");
  expect(changedLines(rewritten)).toBe(50);

  // A file this snapshot changes for the first time is compared with its base.
  const widened = snapshot(
    { "a.ts": body(20), "notes.ts": body(50, "note"), "b.ts": body(8) },
    { "a.ts": body(10), "b.ts": body(5) },
    listed,
  );
  expect(snapshotDelta(widened, reviewed).unseen).toBe(3);
});

it("counts a mode change on a file whose text is unchanged, and treats a huge rewrite as all new", () => {
  const header = "diff --git a/run.sh b/run.sh\n";
  const reviewed = snapshot(
    { "run.sh": body(5) },
    { "run.sh": body(4) },
    header + "index 1..2 100644\n@@ -1,4 +1,5 @@\n",
  );
  const executable = snapshot(
    { "run.sh": body(5) },
    { "run.sh": body(4) },
    header + "old mode 100644\nnew mode 100755\nindex 1..2\n@@ -1,4 +1,5 @@\n",
  );
  const delta = snapshotDelta(executable, reviewed);
  expect(delta.unseen).toBe(1);
  expect(delta.hunks).toContain("new mode 100755");

  // Putting the mode back counts too, though this diff no longer names it.
  const reverted = snapshotDelta(reviewed, executable);
  expect(reverted.unseen).toBe(1);
  expect(reverted.hunks).toContain("this one does not:\nold mode 100644");

  // A mode change on a file the earlier snapshot never touched also counts.
  const untouched = snapshot({ "a.ts": body(3) }, { "a.ts": body(2) });
  const chmod = {
    ...snapshot({ "a.ts": body(3) }, { "a.ts": body(2) }),
    diff: header + "old mode 100644\nnew mode 100755\n",
    changed: ["a.ts", "run.sh"],
  };
  expect(snapshotDelta(chmod, untouched).unseen).toBe(1);
  expect(changedLines(chmod)).toBe(2);

  const big = snapshotDelta(
    snapshot({ "big.ts": body(2500, "new") }),
    snapshot({ "big.ts": body(2500, "old") }),
  );
  expect(big.unseen).toBe(5000);

  // Past the table limit the size of a change is a lower bound, so edits at
  // both ends of a large file cannot make the rest look already reviewed.
  const large = body(2500);
  const edited = large.with(0, "first").with(2499, "last");
  expect(
    changedLines(snapshot({ "big.ts": edited }, { "big.ts": large })),
  ).toBe(4);
  const reviewedLarge = snapshot({ "big.ts": edited }, { "big.ts": large });
  const grown = snapshot(
    { "big.ts": edited, "new.ts": body(100, "new") },
    { "big.ts": large },
  );
  const added = snapshotDelta(grown, reviewedLarge).unseen;
  expect(added).toBe(100);
  expect(added * 2 > changedLines(grown)).toBe(true);
});
