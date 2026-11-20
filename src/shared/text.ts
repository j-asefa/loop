import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkChatMath } from "./remark-chat-math.js";
import { isDisplayFenceLanguage } from "./display-spec.js";

const markdown = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkChatMath)
  .freeze();
type MarkdownNode = ReturnType<typeof markdown.parse>["children"][number];

/** Classify a bounded, raw fence language token, decoding references if present. */
export function isDisplayFenceToken(token: string) {
  if (!token.includes("&")) return isDisplayFenceLanguage(token);
  const node = markdown.parse("~~~" + token + "\n~~~").children[0];
  return node?.type === "code" && isDisplayFenceLanguage(node.lang);
}

/** Plain-text, row-sized preview of markdown: drops syntax, keeps words. */
export function plainPreview(text: string, length = 140) {
  const flat = dropFencedBlocks(text, true)
    .replace(/```[\s\S]*?```/g, " ")
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

/**
 * Removes display source from previews, including open blocks and blocks
 * nested in Markdown containers. Other code is left alone.
 */
export function dropSpecBlocks(text: string) {
  return dropFencedBlocks(text, false);
}

function dropFencedBlocks(text: string, includeBacktickCode: boolean) {
  // A language tag can also spell "spec" with character references.
  if (!includeBacktickCode && !text.includes("spec") && !text.includes("&"))
    return text;
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const kept: string[] = [];
  let end = 0;
  const pending: MarkdownNode[] = markdown.parse(text).children.reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "code" && node.position) {
      const { start, end: stop } = node.position;
      if (start.offset === undefined || stop.offset === undefined) continue;
      if (
        isDisplayFenceLanguage(node.lang) ||
        (includeBacktickCode && text.startsWith("```", start.offset))
      ) {
        // Drop the opener's quote or list markers along with the block.
        kept.push(text.slice(end, start.offset - start.column + 1));
        end = stop.offset;
        if (text[end] === "\r") end++;
        if (text[end] === "\n") end++;
      }
    } else if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--)
        pending.push(node.children[i]);
    }
  }
  kept.push(text.slice(end));
  return kept.join("");
}
