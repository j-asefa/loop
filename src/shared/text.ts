/** Plain-text, row-sized preview of markdown: drops syntax, keeps words. */
export function plainPreview(text: string, length = 140) {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    // A fence still open at the end (an answer being written, or text cut
    // short) is dropped with everything after it, so no source shows.
    .replace(/```[\s\S]*$/, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > length
    ? flat.slice(0, length - 1).trimEnd() + "…"
    : flat;
}

const fenceLine = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
/**
 * Removes fenced `spec` blocks (displays), closed or still open, from Markdown
 * that is about to be flattened to plain text. A display's source is JSON
 * and never reads as words. Other fences are left alone; a `spec` fence
 * inside another fenced block is not a block of its own.
 */
export function dropSpecBlocks(text: string) {
  if (!text.includes("spec")) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let open: { fence: string; spec: boolean } | null = null;
  for (const line of lines) {
    const match = fenceLine.exec(line);
    if (!open) {
      if (match) open = { fence: match[1], spec: match[2] === "spec" };
      if (!open?.spec) kept.push(line);
      continue;
    }
    const closes =
      match &&
      !match[2] &&
      match[1][0] === open.fence[0] &&
      match[1].length >= open.fence.length;
    if (!open.spec) kept.push(line);
    if (closes) open = null;
  }
  return kept.join("\n");
}
