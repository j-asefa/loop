export type MemoryPassage = { start: number; end: number };

const MAX_PASSAGE = 1600;
const MAX_FENCE = 3000;
const PASSAGE_OVERLAP = 500;

function splitBlock(
  content: string,
  start: number,
  end: number,
): MemoryPassage[] {
  const spans: MemoryPassage[] = [];
  while (end - start > MAX_PASSAGE) {
    let cut = start + MAX_PASSAGE;
    const space = content.lastIndexOf(" ", cut - 1);
    if (space > start) cut = space + 1;
    else {
      // Keep a single oversized token intact, so its prefix cannot match
      // just because a passage boundary landed inside it.
      const nextSpace = content.indexOf(" ", cut);
      cut = nextSpace < 0 ? end : Math.min(end, nextSpace + 1);
    }
    if (/[\ud800-\udbff]/.test(content[cut - 1])) cut--;
    spans.push({ start, end: cut });
    const next = content.indexOf(" ", cut - PASSAGE_OVERLAP);
    start = next >= start + 600 && next < cut - 1 ? next + 1 : cut;
  }
  if (start < end) spans.push({ start, end });
  return spans;
}

/** Pack Markdown blocks using raw offsets; overlap splits inside longer blocks. */
export function memoryPassages(content: string): MemoryPassage[] {
  const blocks: MemoryPassage[] = [];
  let start = 0;
  let fence: string | undefined;
  const append = (end: number, fenced = false) => {
    if (end === start) return;
    if (fenced && end - start < MAX_FENCE) blocks.push({ start, end });
    else blocks.push(...splitBlock(content, start, end));
    start = end;
  };
  for (const match of content.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const line = match[0];
    const offset = match.index;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker?.[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length).trim()
      ) {
        append(offset + line.length, true);
        fence = undefined;
      }
    } else if (marker) {
      append(offset);
      fence = marker;
    } else if (/^ {0,3}#{1,6}\s/u.test(line)) {
      append(offset);
    } else if (!line.trim()) {
      append(offset + line.length);
    }
  }
  append(content.length, !!fence);

  const passages: MemoryPassage[] = [];
  for (const block of blocks) {
    const previous = passages.at(-1);
    if (previous && block.end - previous.start <= MAX_PASSAGE)
      previous.end = block.end;
    else passages.push(block);
  }
  return passages.length ? passages : [{ start: 0, end: 0 }];
}
