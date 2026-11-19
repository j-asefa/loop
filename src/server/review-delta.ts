import type { ReviewSnapshot } from "./review-snapshot.js";

// What changed between two captured snapshots of one change, by file content.
// Comparing contents, not diff lines, catches a deleted or moved line and an
// untracked file, which a captured diff lists by name only. Files neither
// snapshot changed are not compared, so an unrelated rebase adds nothing. A
// changed file whose base text differs between the snapshots counts in full,
// which errs towards a full review. Omitted files (binary, oversized, excluded by name) are not
// compared: no review depth reads them.

type Snapshot = Pick<
  ReviewSnapshot,
  "diff" | "files" | "before" | "changed" | "omitted"
>;
type Op = { kind: " " | "-" | "+"; line: string };

const CONTEXT = 3;
const MAX_CELLS = 4_000_000;
const fileText = (files: Record<string, string>, path: string) =>
  Object.hasOwn(files, path) ? files[path] : undefined;
const lines = (text: string | undefined) =>
  text?.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Line edits from `a` to `b`. Past MAX_CELLS the middle is a full rewrite. */
function edits(a: string[], b: string[]): Op[] {
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start,
    m = endB - start;
  const middle: Op[] = [];
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) middle.push({ kind: "-", line: a[i] });
    for (let j = start; j < endB; j++) middle.push({ kind: "+", line: b[j] });
  } else {
    // Longest common subsequence lengths of the suffixes a[i..], b[j..].
    const width = m + 1,
      table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        middle.push({ kind: " ", line: a[start + i] });
        i++;
        j++;
      } else if (
        j === m ||
        (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])
      )
        middle.push({ kind: "-", line: a[start + i++] });
      else middle.push({ kind: "+", line: b[start + j++] });
    }
  }
  const same = (line: string): Op => ({ kind: " ", line });
  return [
    ...a.slice(0, start).map(same),
    ...middle,
    ...a.slice(endA).map(same),
  ];
}
// Changed lines and their neighbours, with the line number in this snapshot.
function excerpt(ops: Op[]) {
  const out: string[] = [];
  let line = 0,
    last = -2;
  ops.forEach((op, index) => {
    if (op.kind !== "-") line++;
    let near = false;
    for (let k = index - CONTEXT; k <= index + CONTEXT && !near; k++)
      near = ops[k] !== undefined && ops[k].kind !== " ";
    if (!near) return;
    if (index > last + 1) out.push(`@@ line ${Math.max(line, 1)} @@`);
    out.push(op.kind + op.line.replace(/\n$/, ""));
    last = index;
  });
  return out.join("\n");
}
// Mode and existence lines of each file's diff header; hunks do not show them.
function modes(diff: string) {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) out.set(line, (current = []));
    else if (line.startsWith("@@")) current = undefined;
    else if (/^(old mode|new mode|new file mode|deleted file mode) /.test(line))
      current?.push(line);
  }
  return out;
}

// Lines of one side with no equal line left on the other: never more than the
// true number of edits, and needs no table.
function unmatched(a: string[], b: string[]) {
  const left = new Map<string, number>();
  for (const line of b) left.set(line, (left.get(line) || 0) + 1);
  let count = b.length;
  for (const line of a) {
    const n = left.get(line) || 0;
    if (n) {
      left.set(line, n - 1);
      count--;
    } else count++;
  }
  return count;
}
const changes = (ops: Op[]) => ops.filter((op) => op.kind !== " ").length;

/**
 * Added and removed lines of a snapshot against its own base, plus one per
 * mode change. This is the size a follow-up is measured against, so it must
 * not overstate: where `edits` would fall back to a full rewrite it counts
 * only lines that cannot be matched at all.
 */
export function changedLines(snapshot: Snapshot) {
  let count = 0;
  for (const path of snapshot.changed) {
    const a = lines(fileText(snapshot.before, path)),
      b = lines(fileText(snapshot.files, path));
    count +=
      a.length * b.length > MAX_CELLS ? unmatched(a, b) : changes(edits(a, b));
  }
  for (const mode of modes(snapshot.diff).values())
    if (mode.some((line) => line.startsWith("old mode "))) count++;
  return count;
}

/**
 * Lines `current` adds to or removes from what `previous` held, over every
 * file either snapshot changed, as a count and as excerpts for the reviewer.
 */
export function snapshotDelta(current: Snapshot, previous: Snapshot) {
  let unseen = 0;
  const hunks: string[] = [];
  const changedNow = new Set(current.changed),
    changedBefore = new Set(previous.changed);
  for (const path of [
    ...new Set([...current.changed, ...previous.changed]),
  ].sort()) {
    const reverted = !changedNow.has(path);
    const oldBase = fileText(previous.before, path);
    const newBase = fileText(current.before, path);
    const then =
      reverted || (changedBefore.has(path) && oldBase === newBase)
        ? fileText(previous.files, path)
        : newBase;
    const now = reverted ? oldBase : fileText(current.files, path);
    if (then === now) continue;
    const ops = edits(lines(then), lines(now));
    // Empty files have no lines, but their presence can affect behavior.
    unseen += Math.max(1, changes(ops));
    const evidence = current.omitted.includes(path)
      ? "This snapshot omits this file; its current contents cannot be compared."
      : excerpt(ops) ||
        (now === undefined ? "Empty file removed." : "Empty file added.");
    hunks.push(
      `--- earlier snapshot: ${path}\n+++ this snapshot: ${path}\n${evidence}`,
    );
  }
  // A mode set, changed or put back since the earlier snapshot. The text may
  // be the same in both, which the content comparison cannot see.
  const before = modes(previous.diff),
    after = modes(current.diff);
  for (const header of new Set([...before.keys(), ...after.keys()])) {
    const earlier = before.get(header) ?? [],
      mode = after.get(header) ?? [];
    if (earlier.join("\n") === mode.join("\n")) continue;
    unseen++;
    hunks.push(
      mode.length
        ? [header, ...mode].join("\n")
        : `${header}\nThe earlier snapshot had this mode change and this one does not:\n${earlier.join("\n")}`,
    );
  }
  return { unseen, hunks: hunks.join("\n") };
}
