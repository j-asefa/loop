import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import Svg, {
  Circle,
  Line,
  Path,
  Polyline,
  Rect,
  SvgXml,
} from "react-native-svg";
import {
  Check,
  CheckSquare,
  Copy,
  CornerDownRight,
  ExternalLink,
  FileCode2,
  Square,
} from "lucide-react-native";
import { getAgentArt } from "../agentArt";
import { resolveLoopFileTarget, type LoopFileTarget } from "../api/files";
import { haptics } from "../haptics";
import {
  findInlineMathAt,
  formatLatexInline,
  parseLatexDisplayRows,
} from "../latex-math";
import type { LoopTheme } from "../theme";
import { MermaidDiagram } from "./MermaidDiagram";

export function AgentAvatar({
  name,
  size = 28,
}: {
  name: string;
  size?: number;
}) {
  const art = useMemo(() => getAgentArt(name), [name]);
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: art.palette.bg,
          overflow: "hidden",
        },
      ]}
    >
      <SvgXml xml={art.avatarSvg} width={size} height={size} />
    </View>
  );
}

export function ProfileCoverBanner({
  name,
  height = 128,
}: {
  name: string;
  height?: number;
}) {
  const art = useMemo(() => getAgentArt(name), [name]);
  return (
    <View
      style={{
        width: "100%",
        height,
        backgroundColor: art.palette.bg,
        overflow: "hidden",
      }}
    >
      <SvgXml xml={art.coverSvg} width="100%" height={height} />
    </View>
  );
}

type SpecElement = {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
};

type ParsedSpec = {
  root: string;
  elements: Record<string, SpecElement>;
};

function parseSpecBlock(source: string): ParsedSpec | null {
  let root = "";
  const elements: Record<string, SpecElement> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const patch = JSON.parse(line) as {
        op?: string;
        path?: string;
        value?: unknown;
      };
      if (patch.op !== "add" || typeof patch.path !== "string") continue;
      if (patch.path === "/root" && typeof patch.value === "string") {
        root = patch.value;
      } else if (
        patch.path.startsWith("/elements/") &&
        patch.value &&
        typeof patch.value === "object"
      ) {
        const key = patch.path.slice("/elements/".length);
        elements[key] = patch.value as SpecElement;
      }
    } catch {
      return null;
    }
  }
  if (!root || !elements[root]) return null;
  return { root, elements };
}

type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: InlineToken[] }
  | { kind: "italic"; children: InlineToken[] }
  | { kind: "boldItalic"; children: InlineToken[] }
  | { kind: "strike"; children: InlineToken[] }
  | { kind: "code"; text: string }
  | { kind: "math"; text: string }
  | {
      kind: "link";
      label: string;
      children?: InlineToken[];
      url: string;
      isLocalFile?: boolean;
    };

const ESCAPABLE_CHARS = new Set(Array.from("\\`*_{}[]()#+-.!~|"));
const URL_STOP_CHARS = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "<",
  ">",
  "(",
  ")",
  '"',
  "'",
]);
const URL_TRIM_CHARS = new Set([".", ",", ";", ":", "!", "?"]);

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95
  );
}

function findClosingDelimiter(
  text: string,
  from: number,
  delim: string,
  requireEndBoundary = false,
): number {
  let i = from;
  while (i <= text.length - delim.length) {
    const ch = text[i];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks++;
      const closeTick = text.indexOf("`".repeat(ticks), i + ticks);
      if (closeTick !== -1) {
        i = closeTick + ticks;
      } else {
        i += ticks;
      }
      continue;
    }
    if (delim.length === 1 && text[i] === delim && text[i + 1] === delim) {
      let run = 2;
      while (text[i + run] === delim) run++;
      i += run;
      continue;
    }
    if (text.startsWith(delim, i)) {
      if (!requireEndBoundary || !isWordChar(text[i + delim.length])) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

function parseLinkAt(
  text: string,
  start: number,
): { label: string; url: string; end: number } | null {
  if (text[start] !== "[") return null;
  let i = start + 1;
  let bracketDepth = 1;
  while (i < text.length && bracketDepth > 0) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
    i++;
  }
  if (bracketDepth !== 0 || text[i] !== "(") return null;
  const label = text.slice(start + 1, i - 1);
  if (!label) return null;

  let j = i + 1;
  let parenDepth = 1;
  while (j < text.length && parenDepth > 0) {
    const ch = text[j];
    if (ch === "\n" || ch === " " || ch === "\t") return null;
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    j++;
  }
  if (parenDepth !== 0) return null;
  const url = text.slice(i + 1, j - 1);
  // Accept http(s) links, file:// references (rendered as code chips), and relative Loop file paths.
  if (!/^(https?:\/\/|file:\/\/)/i.test(url) && !resolveLoopFileTarget(url)) {
    return null;
  }
  return { label, url, end: j };
}

function tokenizeInline(
  text: string,
  depth = 0,
  allowLinks = true,
): InlineToken[] {
  if (!text || depth > 4) return text ? [{ kind: "text", text }] : [];
  const tokens: InlineToken[] = [];
  let i = 0;
  let plain = "";

  const flushPlain = () => {
    if (plain) {
      tokens.push({ kind: "text", text: plain });
      plain = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Inline LaTeX math ($...$ or \(...\)); checked before ESCAPABLE_CHARS so \( is preserved
    if (ch === "$" || (ch === "\\" && text[i + 1] === "(")) {
      const math = findInlineMathAt(text, i);
      if (math) {
        flushPlain();
        tokens.push({ kind: "math", text: formatLatexInline(math.raw) });
        i = math.end;
        continue;
      }
    }

    // Escaped markdown punctuation
    if (
      ch === "\\" &&
      i + 1 < text.length &&
      ESCAPABLE_CHARS.has(text[i + 1])
    ) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code (`code` or ``code``)
    if (ch === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks++;
      const delim = "`".repeat(ticks);
      const close = text.indexOf(delim, i + ticks);
      if (close !== -1 && !text.slice(i + ticks, close).includes("\n")) {
        flushPlain();
        const rawCode = text.slice(i + ticks, close);
        tokens.push({
          kind: "code",
          text: ticks >= 2 ? rawCode.trim() : rawCode,
        });
        i = close + ticks;
        continue;
      }
      plain += delim;
      i += ticks;
      continue;
    }

    // Markdown image ![alt](url) or link [label](url)
    if (allowLinks && (ch === "[" || (ch === "!" && text[i + 1] === "["))) {
      const isImage = ch === "!";
      const link = parseLinkAt(text, isImage ? i + 1 : i);
      if (link) {
        flushPlain();
        const isLocalFile = link.url.toLowerCase().startsWith("file://");
        const displayLabel = link.label || (isImage ? "View image" : link.url);
        tokens.push({
          kind: "link",
          label: displayLabel,
          children:
            isLocalFile || isImage
              ? undefined
              : tokenizeInline(displayLabel, depth + 1, false),
          url: link.url,
          isLocalFile,
        });
        i = link.end;
        continue;
      }
    }

    // Bold + Italic (*** or ___)
    if (
      text.startsWith("***", i) ||
      (text.startsWith("___", i) && !isWordChar(text[i - 1]))
    ) {
      const delim = text.slice(i, i + 3);
      const close = findClosingDelimiter(text, i + 3, delim, delim === "___");
      if (close > i + 3) {
        flushPlain();
        tokens.push({
          kind: "boldItalic",
          children: tokenizeInline(
            text.slice(i + 3, close),
            depth + 1,
            allowLinks,
          ),
        });
        i = close + 3;
        continue;
      }
    }

    // Bold (** or __)
    if (
      text.startsWith("**", i) ||
      (text.startsWith("__", i) && !isWordChar(text[i - 1]))
    ) {
      const delim = text.slice(i, i + 2);
      const close = findClosingDelimiter(text, i + 2, delim, delim === "__");
      if (close > i + 2) {
        flushPlain();
        tokens.push({
          kind: "bold",
          children: tokenizeInline(
            text.slice(i + 2, close),
            depth + 1,
            allowLinks,
          ),
        });
        i = close + 2;
        continue;
      }
    }

    // Strikethrough (~~)
    if (text.startsWith("~~", i)) {
      const close = findClosingDelimiter(text, i + 2, "~~");
      if (close > i + 2) {
        flushPlain();
        tokens.push({
          kind: "strike",
          children: tokenizeInline(
            text.slice(i + 2, close),
            depth + 1,
            allowLinks,
          ),
        });
        i = close + 2;
        continue;
      }
    }

    // Italic (* or _)
    if (
      (ch === "*" &&
        text[i + 1] &&
        text[i + 1] !== " " &&
        text[i + 1] !== "*") ||
      (ch === "_" &&
        !isWordChar(text[i - 1]) &&
        text[i + 1] &&
        text[i + 1] !== " " &&
        text[i + 1] !== "_")
    ) {
      const close = findClosingDelimiter(text, i + 1, ch, ch === "_");
      if (close > i + 1 && text[close - 1] !== " ") {
        flushPlain();
        tokens.push({
          kind: "italic",
          children: tokenizeInline(
            text.slice(i + 1, close),
            depth + 1,
            allowLinks,
          ),
        });
        i = close + 1;
        continue;
      }
    }

    // Bare URLs (http:// or https://)
    if (
      allowLinks &&
      ch === "h" &&
      (text.startsWith("https://", i) || text.startsWith("http://", i)) &&
      !isWordChar(text[i - 1])
    ) {
      let j = i;
      while (j < text.length && !URL_STOP_CHARS.has(text[j])) j++;
      let url = text.slice(i, j);
      while (url.length > 0 && URL_TRIM_CHARS.has(url[url.length - 1])) {
        url = url.slice(0, -1);
      }
      if (url.length > 8) {
        flushPlain();
        tokens.push({ kind: "link", label: url, url });
        i += url.length;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return tokens;
}

function renderInlineTokens(
  tokens: InlineToken[],
  theme: LoopTheme,
  keyPrefix = "",
  opts?: {
    workspaceOrigin?: string | null;
    onOpenFile?: (target: LoopFileTarget, label?: string) => void;
  },
): React.ReactNode[] {
  return tokens.map((tok, idx) => {
    const key = `${keyPrefix}${idx}`;
    if (tok.kind === "bold") {
      return (
        <Text key={key} style={styles.bold}>
          {renderInlineTokens(tok.children, theme, `${key}-`, opts)}
        </Text>
      );
    }
    if (tok.kind === "italic") {
      return (
        <Text key={key} style={styles.italic}>
          {renderInlineTokens(tok.children, theme, `${key}-`, opts)}
        </Text>
      );
    }
    if (tok.kind === "boldItalic") {
      return (
        <Text key={key} style={[styles.bold, styles.italic]}>
          {renderInlineTokens(tok.children, theme, `${key}-`, opts)}
        </Text>
      );
    }
    if (tok.kind === "strike") {
      return (
        <Text key={key} style={[styles.strike, { color: theme.muted }]}>
          {renderInlineTokens(tok.children, theme, `${key}-`, opts)}
        </Text>
      );
    }
    if (tok.kind === "code") {
      return (
        <Text
          key={key}
          style={[
            styles.inlineCode,
            {
              backgroundColor: theme.raised,
              color: theme.brassText,
            },
          ]}
        >
          {` ${tok.text} `}
        </Text>
      );
    }
    if (tok.kind === "math") {
      return (
        <Text
          key={key}
          style={[
            styles.inlineMath,
            {
              backgroundColor: theme.soft,
              color: theme.text,
            },
          ]}
        >
          {` ${tok.text} `}
        </Text>
      );
    }
    if (tok.kind === "link") {
      const loopFile = resolveLoopFileTarget(tok.url, opts?.workspaceOrigin);
      if (loopFile) {
        return (
          <Text
            key={key}
            style={[
              styles.inlineCode,
              {
                backgroundColor: theme.attention,
                color: theme.brassText,
                textDecorationLine: "underline",
              },
            ]}
            onPress={() => {
              haptics.light();
              opts?.onOpenFile?.(loopFile, tok.label);
            }}
          >
            {` 📎 ${tok.label} `}
          </Text>
        );
      }
      if (tok.isLocalFile || !/^https?:\/\//i.test(tok.url)) {
        return (
          <Text
            key={key}
            style={[
              styles.inlineCode,
              {
                backgroundColor: theme.raised,
                color: theme.brassText,
              },
            ]}
          >
            {` ${tok.label} `}
          </Text>
        );
      }
      return (
        <Text
          key={key}
          style={{ color: theme.blue, textDecorationLine: "underline" }}
          onPress={() => {
            haptics.light();
            void Linking.openURL(tok.url).catch(() => {});
          }}
        >
          {tok.children
            ? renderInlineTokens(tok.children, theme, `${key}-l-`, opts)
            : tok.label}
        </Text>
      );
    }
    return <React.Fragment key={key}>{tok.text}</React.Fragment>;
  });
}

export function InlineFormattedText({
  text,
  theme,
  baseStyle,
  numberOfLines,
  onTextLayout,
  workspaceOrigin,
  onOpenFile,
}: {
  text: string;
  theme: LoopTheme;
  baseStyle?: object;
  numberOfLines?: number;
  onTextLayout?: (e: { nativeEvent: { lines: unknown[] } }) => void;
  workspaceOrigin?: string | null;
  onOpenFile?: (target: LoopFileTarget, label?: string) => void;
}) {
  const tokens = useMemo(() => tokenizeInline(text), [text]);
  return (
    <Text
      style={[{ color: theme.text }, baseStyle]}
      numberOfLines={numberOfLines}
      onTextLayout={onTextLayout}
    >
      {renderInlineTokens(tokens, theme, "", { workspaceOrigin, onOpenFile })}
    </Text>
  );
}

type ContentBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string; indent: number }
  | { kind: "numbered"; num: string; text: string; indent: number }
  | { kind: "task"; checked: boolean; text: string; indent: number }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "math"; expr: string }
  | { kind: "spec"; spec: ParsedSpec };

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (trimmed[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += trimmed[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) return false;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cols = stripped.split("|").map((c) => c.trim());
  return cols.length >= 2 && cols.every((c) => /^:?-{3,}:?$/.test(c));
}

function isFenceStart(line: string): { marker: string; lang: string } | null {
  const m = /^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)\s*$/.exec(line);
  if (!m) return null;
  return { marker: m[1], lang: (m[2] ?? "").toLowerCase() };
}

function isHorizontalRule(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  if (compact.length < 3) return false;
  const ch = compact[0];
  if (ch !== "-" && ch !== "*" && ch !== "_") return false;
  for (let i = 1; i < compact.length; i++) {
    if (compact[i] !== ch) return false;
  }
  return true;
}

function parseMarkdownBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const joined = paragraph
      .map((line, idx) => {
        const hardBreak = /(?: {2}|\\)$/.test(line);
        const clean = line.replace(/(?: {2}|\\)$/, "").trim();
        if (idx === paragraph.length - 1) return clean;
        return hardBreak ? `${clean}\n` : `${clean} `;
      })
      .join("")
      .trim();
    if (joined) {
      blocks.push({ kind: "paragraph", text: joined });
    }
    paragraph = [];
  };

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Fenced code or Loop spec block (supports 3+ backticks/tildes and unclosed streaming fences)
    const fence = isFenceStart(rawLine);
    if (fence) {
      flushParagraph();
      const closeChar = fence.marker[0];
      const minLen = fence.marker.length;
      const closeRe = new RegExp(`^\\s*${closeChar}{${minLen},}\\s*$`);
      const bodyLines: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) {
        bodyLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      const body = bodyLines.join("\n");
      if (fence.lang === "spec") {
        const parsed = parseSpecBlock(body);
        if (parsed) {
          blocks.push({ kind: "spec", spec: parsed });
        } else {
          blocks.push({ kind: "code", lang: "spec", code: body.trimEnd() });
        }
      } else if (fence.lang === "math") {
        const expr = body.trim();
        if (expr) {
          blocks.push({ kind: "math", expr });
        }
      } else {
        blocks.push({ kind: "code", lang: fence.lang, code: body.trimEnd() });
      }
      continue;
    }

    // Display math block: $$...$$ (single or multi-line) or \[...\]
    const singleDollarMath = /^\$\$(.+)\$\$$/.exec(trimmed);
    if (singleDollarMath && singleDollarMath[1].trim()) {
      flushParagraph();
      blocks.push({ kind: "math", expr: singleDollarMath[1].trim() });
      i += 1;
      continue;
    }
    const singleBracketMath = /^\\\[(.+)\\\]$/.exec(trimmed);
    if (singleBracketMath && singleBracketMath[1].trim()) {
      flushParagraph();
      blocks.push({ kind: "math", expr: singleBracketMath[1].trim() });
      i += 1;
      continue;
    }
    if (trimmed === "$$" || trimmed === "\\[") {
      const closeDelim = trimmed === "$$" ? "$$" : "\\]";
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === closeDelim) {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx !== -1) {
        flushParagraph();
        const expr = lines
          .slice(i + 1, closeIdx)
          .join("\n")
          .trim();
        if (expr) {
          blocks.push({ kind: "math", expr });
        }
        i = closeIdx + 1;
        continue;
      }
    }

    if (!trimmed) {
      flushParagraph();
      i += 1;
      continue;
    }

    // Horizontal rule
    if (isHorizontalRule(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // Headings (# through ######)
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = Math.min(4, heading[1].length) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "heading", level, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // GFM Markdown table: header row + separator row + optional data rows
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      flushParagraph();
      const headers = splitTableRow(rawLine);
      i += 2; // skip header and separator
      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes("|")) break;
        const cells = splitTableRow(lines[i]);
        while (cells.length < headers.length) cells.push("");
        rows.push(cells.slice(0, headers.length));
        i += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    // Blockquote (consecutive > lines)
    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        const q = lines[i].replace(/^\s*>\s?/, "").trim();
        if (q) quoteLines.push(q);
        i += 1;
      }
      if (quoteLines.length) {
        blocks.push({ kind: "quote", lines: quoteLines });
      }
      continue;
    }

    // Task list item (- [x] or - [ ])
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(rawLine);
    if (task) {
      flushParagraph();
      const indent = Math.min(2, Math.floor(task[1].length / 2));
      blocks.push({
        kind: "task",
        checked: task[2].toLowerCase() === "x",
        text: task[3].trim(),
        indent,
      });
      i += 1;
      continue;
    }

    // Unordered bullet list (-, *, +)
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(rawLine);
    if (bullet) {
      flushParagraph();
      const indent = Math.min(2, Math.floor(bullet[1].length / 2));
      blocks.push({ kind: "bullet", text: bullet[2].trim(), indent });
      i += 1;
      continue;
    }

    // Ordered list (1. or 1))
    const numbered = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(rawLine);
    if (numbered) {
      flushParagraph();
      const indent = Math.min(2, Math.floor(numbered[1].length / 2));
      blocks.push({
        kind: "numbered",
        num: numbered[2],
        text: numbered[3].trim(),
        indent,
      });
      i += 1;
      continue;
    }

    paragraph.push(rawLine);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

const CHART_COLORS = [
  "#e0a350",
  "#32884a",
  "#2288dc",
  "#d2605c",
  "#7878ac",
  "#e098a8",
];

function NativeSpecChart({
  props,
  theme,
}: {
  props: Record<string, unknown>;
  theme: LoopTheme;
}) {
  const [showNumbers, setShowNumbers] = useState(false);
  const title = typeof props.title === "string" ? props.title : undefined;
  const chartType =
    typeof props.type === "string" ? props.type.toLowerCase() : "bar";
  const categories = Array.isArray(props.categories)
    ? props.categories.map(String)
    : [];
  const rawSeries = Array.isArray(props.series)
    ? (props.series as Array<{ name?: string; values?: unknown[] }>)
    : [];
  const series = rawSeries.map((s, i) => ({
    name: s.name || `Series ${i + 1}`,
    values: (Array.isArray(s.values) ? s.values : []).map((v) =>
      Number.isFinite(Number(v)) ? Number(v) : 0,
    ),
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));

  const allValues = series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allValues.map((v) => Math.abs(v)));
  const svgW = 260;
  const svgH = 136;
  const pad = 16;
  const plotW = svgW - pad * 2;
  const plotH = svgH - pad * 2;

  return (
    <View
      style={[
        styles.chartBox,
        { backgroundColor: theme.raised, borderColor: theme.line },
      ]}
    >
      {title && (
        <Text style={[styles.specCardTitle, { color: theme.text }]}>
          {title}
        </Text>
      )}

      {chartType === "pie" && series[0] ? (
        <View style={styles.pieWrap}>
          <Svg width={120} height={120} viewBox="0 0 120 120">
            {(() => {
              const vals = series[0].values;
              const sum = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
              let acc = -Math.PI / 2;
              return vals.map((v, i) => {
                const frac = Math.max(0, v) / sum;
                const next = acc + frac * Math.PI * 2;
                const large = frac > 0.5 ? 1 : 0;
                const x1 = 60 + 48 * Math.cos(acc);
                const y1 = 60 + 48 * Math.sin(acc);
                const x2 = 60 + 48 * Math.cos(next);
                const y2 = 60 + 48 * Math.sin(next);
                acc = next;
                return (
                  <Path
                    key={i}
                    d={`M 60 60 L ${x1} ${y1} A 48 48 0 ${large} 1 ${x2} ${y2} Z`}
                    fill={CHART_COLORS[i % CHART_COLORS.length]}
                  />
                );
              });
            })()}
          </Svg>
        </View>
      ) : (
        <Svg width="100%" height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
          <Line
            x1={pad}
            y1={svgH - pad}
            x2={svgW - pad}
            y2={svgH - pad}
            stroke={theme.line}
            strokeWidth={1}
          />
          {chartType === "line" || chartType === "area"
            ? series.map((s, sIdx) => {
                const count = Math.max(1, s.values.length - 1);
                const pts = s.values.map((v, i) => {
                  const x = pad + (i / count) * plotW;
                  const y = svgH - pad - (Math.max(0, v) / maxVal) * plotH;
                  return `${x},${y}`;
                });
                return (
                  <React.Fragment key={sIdx}>
                    <Polyline
                      points={pts.join(" ")}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2.4}
                    />
                    {s.values.map((v, i) => {
                      const x = pad + (i / count) * plotW;
                      const y = svgH - pad - (Math.max(0, v) / maxVal) * plotH;
                      return (
                        <Circle key={i} cx={x} cy={y} r={3} fill={s.color} />
                      );
                    })}
                  </React.Fragment>
                );
              })
            : categories.map((_, cIdx) => {
                const groupW = plotW / Math.max(1, categories.length);
                const barW = Math.max(
                  6,
                  (groupW - 8) / Math.max(1, series.length),
                );
                return series.map((s, sIdx) => {
                  const val = Math.max(0, s.values[cIdx] ?? 0);
                  const h = (val / maxVal) * plotH;
                  const x = pad + cIdx * groupW + 4 + sIdx * barW;
                  const y = svgH - pad - h;
                  return (
                    <Rect
                      key={`${cIdx}-${sIdx}`}
                      x={x}
                      y={y}
                      width={Math.max(4, barW - 2)}
                      height={Math.max(2, h)}
                      rx={3}
                      fill={s.color}
                    />
                  );
                });
              })}
        </Svg>
      )}

      {categories.length > 0 && (
        <View style={styles.chartLabels}>
          {categories.slice(0, 6).map((c, idx) => (
            <Text
              key={idx}
              style={[styles.chartLabelText, { color: theme.muted }]}
              numberOfLines={1}
            >
              {c}
            </Text>
          ))}
        </View>
      )}

      <Pressable
        onPress={() => {
          haptics.light();
          setShowNumbers((v) => !v);
        }}
        style={styles.chartToggleBtn}
      >
        <Text style={[styles.chartToggleText, { color: theme.brassText }]}>
          {showNumbers ? "Hide numbers" : "Show the numbers"}
        </Text>
      </Pressable>

      {showNumbers && (
        <View style={styles.chartNumbers}>
          {categories.map((cat, cIdx) => (
            <View key={cIdx} style={styles.chartNumRow}>
              <Text style={[styles.chartNumCat, { color: theme.muted }]}>
                {cat}
              </Text>
              <Text style={[styles.chartNumVal, { color: theme.text }]}>
                {series.map((s) => s.values[cIdx] ?? 0).join(" / ")}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function NativeTable({
  columns,
  rows,
  theme,
  highlightLastColumn = false,
  workspaceOrigin,
  onOpenFile,
}: {
  columns: string[];
  rows: string[][];
  theme: LoopTheme;
  highlightLastColumn?: boolean;
  workspaceOrigin?: string | null;
  onOpenFile?: (target: LoopFileTarget, label?: string) => void;
}) {
  const colWidths = useMemo(
    () =>
      columns.map((col, idx) => {
        const longest = Math.max(
          col.length,
          ...rows.map((r) => (r[idx] ?? "").length),
        );
        return Math.min(
          210,
          Math.max(idx === 0 ? 120 : 92, longest * 7.8 + 24),
        );
      }),
    [columns, rows],
  );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.tableScroll, { borderColor: theme.line }]}
    >
      <View>
        <View
          style={[
            styles.tableRow,
            {
              backgroundColor: theme.attention,
              borderBottomColor: theme.attentionLine,
              borderBottomWidth: StyleSheet.hairlineWidth,
            },
          ]}
        >
          {columns.map((col, idx) => (
            <View
              key={idx}
              style={[styles.tableCellWrap, { width: colWidths[idx] }]}
            >
              <InlineFormattedText
                text={col}
                theme={theme}
                baseStyle={[styles.tableHeaderCell, { color: theme.brassText }]}
                workspaceOrigin={workspaceOrigin}
                onOpenFile={onOpenFile}
              />
            </View>
          ))}
        </View>
        {rows.map((row, rowIdx) => (
          <View
            key={rowIdx}
            style={[
              styles.tableRow,
              rowIdx < rows.length - 1 && {
                borderBottomColor: theme.line,
                borderBottomWidth: StyleSheet.hairlineWidth,
              },
              rowIdx % 2 === 1 && { backgroundColor: theme.raised },
            ]}
          >
            {row.map((cell, cellIdx) => (
              <View
                key={cellIdx}
                style={[styles.tableCellWrap, { width: colWidths[cellIdx] }]}
              >
                <InlineFormattedText
                  text={cell}
                  theme={theme}
                  workspaceOrigin={workspaceOrigin}
                  onOpenFile={onOpenFile}
                  baseStyle={[
                    styles.tableCell,
                    cellIdx === 0 && styles.bold,
                    highlightLastColumn &&
                      cellIdx === columns.length - 1 && {
                        color: theme.brassText,
                        fontWeight: "700",
                      },
                  ]}
                />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function SpecNode({
  nodeKey,
  spec,
  theme,
  onReplyButton,
  workspaceOrigin,
  onOpenFile,
}: {
  nodeKey: string;
  spec: ParsedSpec;
  theme: LoopTheme;
  onReplyButton?: (prompt: string) => void;
  workspaceOrigin?: string | null;
  onOpenFile?: (target: LoopFileTarget, label?: string) => void;
}) {
  const el = spec.elements[nodeKey];
  if (!el) return null;
  const props = el.props ?? {};

  if (el.type === "Card" || el.type === "Section") {
    const title = typeof props.title === "string" ? props.title : undefined;
    return (
      <View
        style={[
          styles.specCard,
          { backgroundColor: theme.soft, borderColor: theme.line },
        ]}
      >
        {title ? (
          <Text style={[styles.specCardTitle, { color: theme.text }]}>
            {title}
          </Text>
        ) : null}
        <View style={styles.specChildren}>
          {(el.children ?? []).map((childKey) => (
            <SpecNode
              key={childKey}
              nodeKey={childKey}
              spec={spec}
              theme={theme}
              onReplyButton={onReplyButton}
              workspaceOrigin={workspaceOrigin}
              onOpenFile={onOpenFile}
            />
          ))}
        </View>
      </View>
    );
  }

  if (el.type === "Text") {
    const text = typeof props.content === "string" ? props.content : "";
    return (
      <InlineFormattedText
        text={text}
        theme={theme}
        baseStyle={styles.paragraph}
        workspaceOrigin={workspaceOrigin}
        onOpenFile={onOpenFile}
      />
    );
  }

  if (el.type === "Divider") {
    return (
      <View
        style={{
          height: StyleSheet.hairlineWidth,
          backgroundColor: theme.line,
          marginVertical: 4,
        }}
      />
    );
  }

  if (el.type === "Fields") {
    return (
      <View style={styles.fieldsGrid}>
        {(el.children ?? []).map((childKey) => (
          <SpecNode
            key={childKey}
            nodeKey={childKey}
            spec={spec}
            theme={theme}
            onReplyButton={onReplyButton}
            workspaceOrigin={workspaceOrigin}
            onOpenFile={onOpenFile}
          />
        ))}
      </View>
    );
  }

  if (el.type === "Field") {
    const label = typeof props.label === "string" ? props.label : "";
    const value =
      typeof props.value === "string" ? props.value : String(props.value ?? "");
    return (
      <View
        style={[
          styles.fieldTile,
          { backgroundColor: theme.raised, borderColor: theme.line },
        ]}
      >
        <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text>
        <Text style={[styles.fieldValue, { color: theme.text }]}>{value}</Text>
      </View>
    );
  }

  if (el.type === "Chart") {
    return <NativeSpecChart props={props} theme={theme} />;
  }

  if (el.type === "Table") {
    const columns = Array.isArray(props.columns)
      ? props.columns.map(String)
      : [];
    const rows = Array.isArray(props.rows)
      ? (props.rows as unknown[]).map((row) =>
          Array.isArray(row) ? row.map(String) : [],
        )
      : [];
    return (
      <NativeTable
        columns={columns}
        rows={rows}
        theme={theme}
        highlightLastColumn
        workspaceOrigin={workspaceOrigin}
        onOpenFile={onOpenFile}
      />
    );
  }

  if (el.type === "Actions") {
    return (
      <View style={styles.specActions}>
        {(el.children ?? []).map((childKey) => (
          <SpecNode
            key={childKey}
            nodeKey={childKey}
            spec={spec}
            theme={theme}
            onReplyButton={onReplyButton}
            workspaceOrigin={workspaceOrigin}
            onOpenFile={onOpenFile}
          />
        ))}
      </View>
    );
  }

  if (el.type === "LinkButton") {
    const label = typeof props.label === "string" ? props.label : "Open link";
    const url = typeof props.url === "string" ? props.url : "";
    const loopFile = resolveLoopFileTarget(url, workspaceOrigin);
    if (!loopFile && !/^https?:\/\//i.test(url)) return null;
    return (
      <Pressable
        onPress={() => {
          haptics.light();
          if (loopFile) {
            onOpenFile?.(loopFile, label);
          } else {
            void Linking.openURL(url).catch(() => {});
          }
        }}
        style={({ pressed }) => [
          styles.replySpecBtn,
          {
            backgroundColor: loopFile ? theme.attention : theme.raised,
            borderColor: loopFile ? theme.attentionLine : theme.line,
            opacity: pressed ? 0.78 : 1,
          },
        ]}
      >
        <ExternalLink
          size={14}
          color={loopFile ? theme.brassText : theme.blue}
        />
        <Text
          style={[
            styles.replySpecBtnText,
            { color: loopFile ? theme.brassText : theme.blue },
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  if (el.type === "ReplyButton") {
    const label = typeof props.label === "string" ? props.label : "Reply";
    const prompt = typeof props.prompt === "string" ? props.prompt : label;
    return (
      <Pressable
        onPress={() => {
          haptics.light();
          onReplyButton?.(prompt);
        }}
        style={({ pressed }) => [
          styles.replySpecBtn,
          {
            backgroundColor: theme.attention,
            borderColor: theme.attentionLine,
            opacity: pressed ? 0.78 : 1,
            transform: [{ scale: pressed ? 0.97 : 1 }],
          },
        ]}
      >
        <CornerDownRight size={14} color={theme.brassText} />
        <Text style={[styles.replySpecBtnText, { color: theme.brassText }]}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return null;
}

export const RichContent = React.memo(function RichContent({
  content,
  theme,
  onReplyButton,
  workspaceOrigin,
  onOpenFile,
  skipLeadingHeading,
}: {
  content: string;
  theme: LoopTheme;
  onReplyButton?: (prompt: string) => void;
  workspaceOrigin?: string | null;
  onOpenFile?: (target: LoopFileTarget, label?: string) => void;
  /** Avoid repeating a Markdown heading that was already promoted as the card title. */
  skipLeadingHeading?: string;
}) {
  const blocks = useMemo(() => {
    const parsed = parseMarkdownBlocks(content);
    if (
      skipLeadingHeading &&
      parsed[0]?.kind === "heading" &&
      parsed[0].text.trim().toLowerCase() ===
        skipLeadingHeading.trim().toLowerCase()
    ) {
      return parsed.slice(1);
    }
    return parsed;
  }, [content, skipLeadingHeading]);

  return (
    <View style={styles.container}>
      {blocks.map((block, idx) => {
        if (block.kind === "heading") {
          const levelStyle =
            block.level === 1
              ? styles.h1
              : block.level === 2
                ? styles.h2
                : block.level === 3
                  ? styles.h3
                  : styles.h4;
          return (
            <InlineFormattedText
              key={idx}
              text={block.text}
              theme={theme}
              workspaceOrigin={workspaceOrigin}
              onOpenFile={onOpenFile}
              baseStyle={[
                styles.heading,
                levelStyle,
                idx > 0 && { marginTop: 8 },
              ]}
            />
          );
        }
        if (block.kind === "paragraph") {
          return (
            <InlineFormattedText
              key={idx}
              text={block.text}
              theme={theme}
              workspaceOrigin={workspaceOrigin}
              onOpenFile={onOpenFile}
              baseStyle={styles.paragraph}
            />
          );
        }
        if (block.kind === "hr") {
          return (
            <View
              key={idx}
              style={[styles.hr, { backgroundColor: theme.line }]}
            />
          );
        }
        if (block.kind === "quote") {
          return (
            <View
              key={idx}
              style={[
                styles.quoteBox,
                {
                  borderLeftColor: theme.brass,
                  backgroundColor: theme.soft,
                },
              ]}
            >
              {block.lines.map((line, lIdx) => (
                <InlineFormattedText
                  key={lIdx}
                  text={line}
                  theme={theme}
                  workspaceOrigin={workspaceOrigin}
                  onOpenFile={onOpenFile}
                  baseStyle={[styles.quoteText, { color: theme.muted }]}
                />
              ))}
            </View>
          );
        }
        if (block.kind === "task") {
          return (
            <View
              key={idx}
              style={[styles.listRow, { paddingLeft: 2 + block.indent * 16 }]}
            >
              <View style={styles.taskIconWrap}>
                {block.checked ? (
                  <CheckSquare size={16} color={theme.brassText} />
                ) : (
                  <Square size={16} color={theme.muted} />
                )}
              </View>
              <View style={styles.listContent}>
                <InlineFormattedText
                  text={block.text}
                  theme={theme}
                  workspaceOrigin={workspaceOrigin}
                  onOpenFile={onOpenFile}
                  baseStyle={[
                    styles.listText,
                    block.checked && {
                      textDecorationLine: "line-through",
                      color: theme.muted,
                    },
                  ]}
                />
              </View>
            </View>
          );
        }
        if (block.kind === "bullet") {
          return (
            <View
              key={idx}
              style={[styles.listRow, { paddingLeft: 2 + block.indent * 16 }]}
            >
              <Text style={[styles.listBullet, { color: theme.brassText }]}>
                {block.indent > 0 ? "◦" : "•"}
              </Text>
              <View style={styles.listContent}>
                <InlineFormattedText
                  text={block.text}
                  theme={theme}
                  workspaceOrigin={workspaceOrigin}
                  onOpenFile={onOpenFile}
                  baseStyle={styles.listText}
                />
              </View>
            </View>
          );
        }
        if (block.kind === "numbered") {
          return (
            <View
              key={idx}
              style={[styles.listRow, { paddingLeft: 2 + block.indent * 16 }]}
            >
              <Text style={[styles.listNum, { color: theme.brassText }]}>
                {block.num}.
              </Text>
              <View style={styles.listContent}>
                <InlineFormattedText
                  text={block.text}
                  theme={theme}
                  workspaceOrigin={workspaceOrigin}
                  onOpenFile={onOpenFile}
                  baseStyle={styles.listText}
                />
              </View>
            </View>
          );
        }
        if (block.kind === "table") {
          return (
            <NativeTable
              key={idx}
              columns={block.headers}
              rows={block.rows}
              theme={theme}
              workspaceOrigin={workspaceOrigin}
              onOpenFile={onOpenFile}
            />
          );
        }
        if (block.kind === "code") {
          if (block.lang === "mermaid") {
            return <MermaidDiagram key={idx} code={block.code} theme={theme} />;
          }
          return (
            <CodeBlock
              key={idx}
              lang={block.lang}
              code={block.code}
              theme={theme}
            />
          );
        }
        if (block.kind === "math") {
          return <MathBlock key={idx} expr={block.expr} theme={theme} />;
        }
        return (
          <SpecNode
            key={idx}
            nodeKey={block.spec.root}
            spec={block.spec}
            theme={theme}
            onReplyButton={onReplyButton}
            workspaceOrigin={workspaceOrigin}
            onOpenFile={onOpenFile}
          />
        );
      })}
    </View>
  );
});

function MathBlock({ expr, theme }: { expr: string; theme: LoopTheme }) {
  const rows = useMemo(() => parseLatexDisplayRows(expr), [expr]);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = () => {
    haptics.success();
    void Clipboard.setStringAsync(expr)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setCopied(false);
        }, 1800);
      })
      .catch(() => {});
  };

  return (
    <View
      style={[
        styles.mathBlock,
        { backgroundColor: theme.soft, borderColor: theme.line },
      ]}
    >
      <View style={styles.codeHeadRow}>
        <Text style={[styles.codeLang, { color: theme.brassText }]}>math</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "LaTeX copied" : "Copy LaTeX"}
          hitSlop={8}
          onPress={handleCopy}
          style={({ pressed }) => [
            styles.codeCopyBtn,
            {
              backgroundColor: pressed ? theme.attention : theme.surface,
              borderColor: copied ? theme.attentionLine : theme.line,
            },
          ]}
        >
          {copied ? (
            <Check size={12} color={theme.brassText} />
          ) : (
            <Copy size={12} color={theme.muted} />
          )}
          <Text
            style={[
              styles.codeCopyText,
              { color: copied ? theme.brassText : theme.muted },
            ]}
          >
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.mathScrollContent}
      >
        <View style={styles.mathRows}>
          {rows.map((row, rIdx) => (
            <View key={rIdx} style={styles.mathRow}>
              {row.map((seg, sIdx) => {
                if (seg.kind === "fraction") {
                  return (
                    <View key={sIdx} style={styles.mathFraction}>
                      <Text
                        style={[styles.mathFracPart, { color: theme.text }]}
                      >
                        {seg.num}
                      </Text>
                      <View
                        style={[
                          styles.mathFracBar,
                          { backgroundColor: theme.text },
                        ]}
                      />
                      <Text
                        style={[styles.mathFracPart, { color: theme.text }]}
                      >
                        {seg.den}
                      </Text>
                    </View>
                  );
                }
                if (seg.kind === "matrix") {
                  return (
                    <View key={sIdx} style={styles.mathMatrixWrap}>
                      {seg.left ? (
                        <Text
                          style={[
                            styles.mathMatrixDelim,
                            { color: theme.brassText },
                          ]}
                        >
                          {seg.left}
                        </Text>
                      ) : null}
                      <View style={styles.mathMatrixBody}>
                        {seg.rows.map((mRow, mrIdx) => (
                          <View key={mrIdx} style={styles.mathMatrixRow}>
                            {mRow.map((cell, mcIdx) => (
                              <Text
                                key={mcIdx}
                                style={[
                                  styles.mathMatrixCell,
                                  { color: theme.text },
                                ]}
                              >
                                {cell}
                              </Text>
                            ))}
                          </View>
                        ))}
                      </View>
                      {seg.right ? (
                        <Text
                          style={[
                            styles.mathMatrixDelim,
                            { color: theme.brassText },
                          ]}
                        >
                          {seg.right}
                        </Text>
                      ) : null}
                    </View>
                  );
                }
                return (
                  <Text
                    key={sIdx}
                    style={[styles.mathText, { color: theme.text }]}
                  >
                    {seg.text}
                  </Text>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function CodeBlock({
  lang,
  code,
  theme,
}: {
  lang: string;
  code: string;
  theme: LoopTheme;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = () => {
    haptics.success();
    void Clipboard.setStringAsync(code)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setCopied(false);
        }, 1800);
      })
      .catch(() => {});
  };

  return (
    <View
      style={[
        styles.codeBlock,
        { backgroundColor: theme.raised, borderColor: theme.line },
      ]}
    >
      <View style={styles.codeHeadRow}>
        <View style={styles.codeHead}>
          <FileCode2 size={12} color={theme.muted} />
          <Text style={[styles.codeLang, { color: theme.muted }]}>
            {lang || "code"}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Code copied" : "Copy code"}
          hitSlop={8}
          onPress={handleCopy}
          style={({ pressed }) => [
            styles.codeCopyBtn,
            {
              backgroundColor: pressed ? theme.attention : theme.soft,
              borderColor: copied ? theme.attentionLine : theme.line,
            },
          ]}
        >
          {copied ? (
            <Check size={12} color={theme.brassText} />
          ) : (
            <Copy size={12} color={theme.muted} />
          )}
          <Text
            style={[
              styles.codeCopyText,
              { color: copied ? theme.brassText : theme.muted },
            ]}
          >
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={[styles.codeText, { color: theme.text }]}>{code}</Text>
      </ScrollView>
    </View>
  );
}

/** Plain clean snippet for Feed stack cards (strips fenced spec & markdown syntax). */
export { feedPreviewText } from "../fixtures";

const styles = StyleSheet.create({
  container: {
    gap: 11,
  },
  avatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontWeight: "700",
  },
  heading: {
    fontWeight: "700",
    letterSpacing: -0.25,
  },
  h1: {
    fontSize: 22,
    lineHeight: 28,
  },
  h2: {
    fontSize: 19,
    lineHeight: 25.5,
  },
  h3: {
    fontSize: 17.5,
    lineHeight: 24,
  },
  h4: {
    fontSize: 16.5,
    lineHeight: 22.5,
  },
  paragraph: {
    fontSize: 16.5,
    lineHeight: 25,
  },
  bold: {
    fontWeight: "700",
  },
  italic: {
    fontStyle: "italic",
  },
  strike: {
    textDecorationLine: "line-through",
  },
  inlineCode: {
    fontFamily: "Courier",
    fontSize: 14.5,
    borderRadius: 4,
  },
  hr: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
  },
  quoteBox: {
    borderLeftWidth: 3,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    gap: 4,
  },
  quoteText: {
    fontSize: 15.5,
    lineHeight: 23,
    fontStyle: "italic",
  },
  codeBlock: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  codeHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  codeLang: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  codeText: {
    fontFamily: "Courier",
    fontSize: 13.5,
    lineHeight: 20,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  taskIconWrap: {
    paddingTop: 4,
  },
  listBullet: {
    fontSize: 17.5,
    lineHeight: 24.5,
    fontWeight: "700",
    width: 14,
    textAlign: "center",
  },
  listNum: {
    fontSize: 15.5,
    lineHeight: 24.5,
    fontWeight: "700",
    minWidth: 20,
    fontVariant: ["tabular-nums"],
  },
  listContent: {
    flex: 1,
  },
  listText: {
    fontSize: 16.5,
    lineHeight: 24.5,
  },
  specCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 13,
    gap: 10,
    marginTop: 2,
  },
  specCardTitle: {
    fontSize: 15.5,
    fontWeight: "700",
  },
  specChildren: {
    gap: 10,
  },
  fieldsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  fieldTile: {
    minWidth: "46%",
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 3,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  fieldValue: {
    fontSize: 15,
    fontWeight: "700",
  },
  chartBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 11,
    gap: 8,
  },
  pieWrap: {
    alignItems: "center",
    paddingVertical: 4,
  },
  chartLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 4,
  },
  chartLabelText: {
    fontSize: 11,
    flex: 1,
    textAlign: "center",
  },
  chartToggleBtn: {
    alignSelf: "flex-start",
  },
  chartToggleText: {
    fontSize: 13,
    fontWeight: "600",
  },
  chartNumbers: {
    gap: 4,
  },
  chartNumRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  chartNumCat: {
    fontSize: 13,
  },
  chartNumVal: {
    fontSize: 13,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  tableScroll: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  tableCellWrap: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tableCell: {
    fontSize: 14,
    lineHeight: 20,
  },
  tableHeaderCell: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  specActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  replySpecBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  replySpecBtnText: {
    fontSize: 13.5,
    fontWeight: "600",
  },
  codeHeadRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  codeCopyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeCopyText: {
    fontSize: 11,
    fontWeight: "600",
  },
  inlineMath: {
    fontSize: 15.5,
    fontStyle: "italic",
    borderRadius: 4,
  },
  mathBlock: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  mathScrollContent: {
    paddingVertical: 4,
    minWidth: "100%",
    justifyContent: "center",
  },
  mathRows: {
    gap: 8,
    alignItems: "center",
  },
  mathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  mathText: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: "500",
  },
  mathFraction: {
    alignItems: "center",
    paddingHorizontal: 3,
  },
  mathFracPart: {
    fontSize: 14.5,
    lineHeight: 19,
    textAlign: "center",
  },
  mathFracBar: {
    height: 1.25,
    alignSelf: "stretch",
    minWidth: 18,
    marginVertical: 2,
  },
  mathMatrixWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  mathMatrixDelim: {
    fontSize: 28,
    fontWeight: "300",
  },
  mathMatrixBody: {
    gap: 3,
  },
  mathMatrixRow: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  mathMatrixCell: {
    fontSize: 15,
    lineHeight: 20,
    textAlign: "center",
  },
});
