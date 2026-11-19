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
  changed: [...new Set([...Object.keys(files), ...Object.keys(before)])].sort(),
  files: Object.fromEntries(
    Object.entries(files).map(([path, lines]) => [path, lines.join("\n")]),
  ),
  before: Object.fromEntries(
    Object.entries(before).map(([path, lines]) => [path, lines.join("\n")]),
  ),
});

it("finds nothing new when the changed files have the same contents, whatever their diffs say", () => {
  const reviewed = snapshot(
    { "a.ts": body(40) },
    { "a.ts": body(30) },
    "diff --git a/a.ts b/a.ts\nindex 111..222 100644\n@@ -28,3 +28,13 @@\n",
  );
  // The same content after a rebase: another base, blob ids and hunk offsets.
  const rebased = snapshot(
    { "a.ts": body(40) },
    { "a.ts": ["upstream", ...body(30)] },
    "diff --git a/a.ts b/a.ts\nindex 333..444 100644\n@@ -1,4 +1,13 @@\n",
  );
  expect(snapshotDelta(rebased, reviewed)).toEqual({ unseen: 0, hunks: "" });
  expect(changedLines(reviewed)).toBe(10);
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
  expect(delta.hunks).toContain("-line 19");
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

  const big = snapshotDelta(
    snapshot({ "big.ts": body(2500, "new") }),
    snapshot({ "big.ts": body(2500, "old") }),
  );
  expect(big.unseen).toBe(5000);
});
