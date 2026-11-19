export type MemoryPassage = { start: number; end: number };

const MAX_PASSAGE = 1600;
const MAX_FENCE = 3000;
const PASSAGE_OVERLAP = 500;

function splitBlock(
  content: string,
  start: number,
  end: number,
  overlap: number,
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
    const next = content.indexOf(" ", cut - overlap);
    start = next >= start + 600 && next < cut - 1 ? next + 1 : cut;
  }
  if (start < end) spans.push({ start, end });
  return spans;
}

/** Pack Markdown blocks using raw offsets; overlap splits inside longer blocks. */
export function memoryPassages(
  content: string,
  result = false,
): MemoryPassage[] {
  const blocks: MemoryPassage[] = [];
  let start = 0;
  let fence: string | undefined;
  const fencedBlocks: MemoryPassage[] = [];
  const append = (end: number, fenced = false) => {
    if (end === start) return;
    if (fenced && end - start < MAX_FENCE) {
      const block = { start, end };
      blocks.push(block);
      fencedBlocks.push(block);
    } else
      blocks.push(
        ...splitBlock(content, start, end, result ? 850 : PASSAGE_OVERLAP),
      );
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
  // Published output can place a decision across two adjacent paragraphs.
  // Add an overlapping raw span at each eligible boundary.
  if (result && passages.length > 1) {
    const bridges: MemoryPassage[] = [];
    for (let index = 1; index < passages.length; index++) {
      const previous = passages[index - 1];
      const next = passages[index];
      const boundary = next.start;
      if (previous.end - boundary > 500) continue;
      const left = Math.max(previous.start, boundary - 800);
      const right = Math.min(next.end, boundary + 800);
      const leftSpace = content.indexOf(" ", left);
      const rightSpace = content.lastIndexOf(" ", right - 1);
      if (
        leftSpace < left ||
        leftSpace >= boundary ||
        rightSpace <= previous.end
      )
        continue;
      const start = leftSpace + 1;
      const end = rightSpace + 1;
      if (
        fencedBlocks.some(
          (block) =>
            (block.start < start && start < block.end) ||
            (block.start < end && end < block.end),
        )
      )
        continue;
      bridges.push({ start, end });
    }
    passages.push(...bridges);
    passages.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return passages.length ? passages : [{ start: 0, end: 0 }];
}
