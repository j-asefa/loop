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
const PREVIEW_MARKDOWN_LIMIT = 64 * 1024;

/** Classify a bounded, raw fence language token, decoding references if present. */
export function isDisplayFenceToken(token: string) {
  if (!token.includes("&")) return isDisplayFenceLanguage(token);
  const node = markdown.parse("~~~" + token + "\n~~~").children[0];
  return node?.type === "code" && isDisplayFenceLanguage(node.lang);
}

/** Plain-text, row-sized preview of markdown: drops syntax, keeps words. */
export function plainPreview(text: string, length = 140) {
  const flat = dropFencedBlocks(text, true)
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
 * nested in Markdown containers. Normal parsing leaves other code alone;
 * oversized or unparseable input falls back to prose outside fenced blocks.
 */
export function dropSpecBlocks(text: string) {
  return dropFencedBlocks(text, false);
}

/** Linear, conservative prose fallback: omit fenced source without parsing it. */
export function markdownFallbackText(text: string) {
  const kept: string[] = [];
  let open: { marker: string; quotes: number; indent: number } | undefined;
  for (const [line] of text.matchAll(/[^\r\n]*(?:\r\n?|\n|$)/g)) {
    const fence = /(`{3,}|~{3,})/.exec(line);
    const prefix = fence ? line.slice(0, fence.index) : "";
    // Accept quote/list containers without recursively interpreting them.
    const possible =
      fence && /^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*$/.test(prefix);
    if (!open) {
      if (possible)
        open = {
          marker: fence[0],
          quotes: prefix.split(">").length - 1,
          indent: prefix.replace(/\t/g, "    ").length,
        };
      else kept.push(line);
    } else if (
      possible &&
      fence[0][0] === open.marker[0] &&
      fence[0].length >= open.marker.length &&
      /^[ \t>]*$/.test(prefix) &&
      prefix.split(">").length - 1 === open.quotes &&
      prefix.replace(/\t/g, "    ").length <= open.indent + 3 &&
      /^[ \t\r\n]*$/.test(line.slice(fence.index + fence[0].length))
    )
      open = undefined;
  }
  return kept.join("");
}

function dropFencedBlocks(text: string, includeBacktickCode: boolean) {
  // A language tag can also spell "spec" with character references.
  if (!includeBacktickCode && !text.includes("spec") && !text.includes("&"))
    return text;
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const kept: string[] = [];
  // Preserve legacy handling of inline backticks within each retained span.
  // A removed block must not cause its preceding and following markers to pair.
  const keep = (span: string) =>
    includeBacktickCode ? span.replace(/```[\s\S]*?```/g, " ") : span;
  // Preview generation must not prevent the stored answer from being read.
  // If parsing is unsafe, omit all fenced source with a linear scanner while
  // retaining prose after closed blocks. Returning raw input can expose JSON.
  const fallback = () => keep(markdownFallbackText(text));
  if (text.length > PREVIEW_MARKDOWN_LIMIT) return fallback();
  let pending: MarkdownNode[];
  try {
    pending = markdown.parse(text).children.reverse();
  } catch {
    // Bounded input can still exceed the parser's recursive nesting limit.
    return fallback();
  }
  let end = 0;
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
        kept.push(keep(text.slice(end, start.offset - start.column + 1)));
        end = stop.offset;
        if (text[end] === "\r") end++;
        if (text[end] === "\n") end++;
      }
    } else if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--)
        pending.push(node.children[i]);
    }
  }
  kept.push(keep(text.slice(end)));
  return kept.join("");
}
