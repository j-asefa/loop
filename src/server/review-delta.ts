// Compares two captured unified diffs of one change. A changed line counts as
// seen when the reviewed diff has the same line in the same file, so a rebase
// or an amended commit does not make reviewed code look new.

type Section = { path: string; header: string[]; hunks: string[][] };

function sections(diff: string): Section[] {
  const out: Section[] = [];
  let section: Section | undefined, hunk: string[] | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      section = { path: line, header: [line], hunks: [] };
      hunk = undefined;
      out.push(section);
    } else if (!section) continue;
    else if (line.startsWith("@@")) {
      hunk = [line];
      section.hunks.push(hunk);
    } else if (hunk) hunk.push(line);
    else section.header.push(line);
  }
  return out;
}
const isChange = (line: string) => line[0] === "+" || line[0] === "-";
// A section without hunks (a binary or mode-only change) is one change.
const whole = (section: Section) => section.header.slice(1).join("\n");

const CONTEXT = 3;
// Only the unseen lines of a hunk and their neighbours: a new file is one hunk,
// and repeating all of it would hide the lines that changed.
function excerpt(hunk: string[], unseen: Set<number>) {
  const out = [hunk[0]];
  let last = 0;
  for (let i = 1; i < hunk.length; i++) {
    let near = false;
    for (let j = i - CONTEXT; j <= i + CONTEXT && !near; j++)
      near = unseen.has(j);
    if (!near) continue;
    if (i > last + 1) out.push("[…]");
    out.push(hunk[i]);
    last = i;
  }
  if (last < hunk.length - 1) out.push("[…]");
  return out.join("\n");
}

export function reviewDelta(current: string, reviewed: string) {
  const seen = new Map<string, number>();
  const key = (section: Section, line: string) => section.path + "\n" + line;
  const take = (section: Section, line: string) => {
    const left = seen.get(key(section, line)) || 0;
    if (left) seen.set(key(section, line), left - 1);
    return left > 0;
  };
  for (const section of sections(reviewed))
    for (const line of section.hunks.length
      ? section.hunks.flat().filter(isChange)
      : [whole(section)])
      seen.set(key(section, line), (seen.get(key(section, line)) || 0) + 1);
  let changed = 0,
    unseen = 0;
  const hunks: string[] = [];
  for (const section of sections(current)) {
    const fresh: string[] = [];
    let sectionNew = false;
    if (!section.hunks.length) {
      changed++;
      if (!take(section, whole(section))) {
        unseen++;
        sectionNew = true;
      }
    }
    for (const hunk of section.hunks) {
      const lines = new Set<number>();
      hunk.forEach((line, i) => {
        if (!isChange(line)) return;
        changed++;
        if (!take(section, line)) lines.add(i);
      });
      unseen += lines.size;
      if (lines.size) fresh.push(excerpt(hunk, lines));
    }
    if (sectionNew || fresh.length)
      hunks.push([section.header.join("\n"), ...fresh].join("\n"));
  }
  return { changed, unseen, hunks: hunks.join("\n") };
}
