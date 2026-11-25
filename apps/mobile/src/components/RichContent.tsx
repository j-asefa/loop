import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CornerDownRight } from "lucide-react-native";
import { haptics } from "../haptics";
import { avatarColors, type LoopTheme } from "../theme";

export function AgentAvatar({
  name,
  size = 28,
}: {
  name: string;
  size?: number;
}) {
  const clean = name.replace(/^@/, "");
  const initial = (clean[0] ?? "A").toUpperCase();
  const colors = avatarColors(clean);
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.bg,
        },
      ]}
    >
      <Text
        style={[
          styles.avatarText,
          { color: colors.fg, fontSize: Math.round(size * 0.45) },
        ]}
      >
        {initial}
      </Text>
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
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string };

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith("**") && raw.endsWith("**")) {
      tokens.push({ kind: "bold", text: raw.slice(2, -2) });
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      tokens.push({ kind: "code", text: raw.slice(1, -1) });
    } else if (raw.startsWith("*") && raw.endsWith("*")) {
      tokens.push({ kind: "italic", text: raw.slice(1, -1) });
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return tokens;
}

export function InlineFormattedText({
  text,
  theme,
  baseStyle,
  numberOfLines,
  onTextLayout,
}: {
  text: string;
  theme: LoopTheme;
  baseStyle?: object;
  numberOfLines?: number;
  onTextLayout?: (e: { nativeEvent: { lines: unknown[] } }) => void;
}) {
  const tokens = useMemo(() => tokenizeInline(text), [text]);
  return (
    <Text
      style={[{ color: theme.text }, baseStyle]}
      numberOfLines={numberOfLines}
      onTextLayout={onTextLayout}
    >
      {tokens.map((tok, idx) => {
        if (tok.kind === "bold") {
          return (
            <Text key={idx} style={styles.bold}>
              {tok.text}
            </Text>
          );
        }
        if (tok.kind === "italic") {
          return (
            <Text key={idx} style={styles.italic}>
              {tok.text}
            </Text>
          );
        }
        if (tok.kind === "code") {
          return (
            <Text
              key={idx}
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
        return <React.Fragment key={idx}>{tok.text}</React.Fragment>;
      })}
    </Text>
  );
}

type ContentBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; num: string; text: string }
  | { kind: "spec"; spec: ParsedSpec };

function parseMarkdownBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const fenceRegex = /```spec\s*\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pushMarkdown = (chunk: string) => {
    const lines = chunk.split(/\r?\n/);
    let paragraph: string[] = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flushParagraph();
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph();
        blocks.push({
          kind: "heading",
          level: heading[1].length as 1 | 2 | 3,
          text: heading[2].trim(),
        });
        continue;
      }
      const bullet = /^[-*]\s+(.+)$/.exec(line);
      if (bullet) {
        flushParagraph();
        blocks.push({ kind: "bullet", text: bullet[1].trim() });
        continue;
      }
      const numbered = /^(\d+)\.\s+(.+)$/.exec(line);
      if (numbered) {
        flushParagraph();
        blocks.push({
          kind: "numbered",
          num: numbered[1],
          text: numbered[2].trim(),
        });
        continue;
      }
      paragraph.push(line);
    }
    flushParagraph();
  };

  while ((match = fenceRegex.exec(content)) !== null) {
    if (match.index > cursor) {
      pushMarkdown(content.slice(cursor, match.index));
    }
    const parsed = parseSpecBlock(match[1]);
    if (parsed) {
      blocks.push({ kind: "spec", spec: parsed });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    pushMarkdown(content.slice(cursor));
  }
  return blocks;
}

function SpecNode({
  nodeKey,
  spec,
  theme,
  onReplyButton,
}: {
  nodeKey: string;
  spec: ParsedSpec;
  theme: LoopTheme;
  onReplyButton?: (prompt: string) => void;
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
      />
    );
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
              <Text
                key={idx}
                style={[
                  styles.tableCell,
                  styles.tableHeaderCell,
                  {
                    color: theme.brassText,
                    width: idx === 0 ? 132 : 84,
                  },
                ]}
              >
                {col}
              </Text>
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
                <Text
                  key={cellIdx}
                  style={[
                    styles.tableCell,
                    cellIdx === 0 && styles.bold,
                    cellIdx === columns.length - 1 && {
                      color: theme.brassText,
                      fontWeight: "700",
                    },
                    {
                      color:
                        cellIdx === columns.length - 1
                          ? theme.brassText
                          : theme.text,
                      width: cellIdx === 0 ? 132 : 84,
                    },
                  ]}
                >
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
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
          />
        ))}
      </View>
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
        <CornerDownRight size={13} color={theme.brassText} />
        <Text style={[styles.replySpecBtnText, { color: theme.brassText }]}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return null;
}

export function RichContent({
  content,
  theme,
  onReplyButton,
  skipLeadingHeading,
}: {
  content: string;
  theme: LoopTheme;
  onReplyButton?: (prompt: string) => void;
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
          return (
            <InlineFormattedText
              key={idx}
              text={block.text}
              theme={theme}
              baseStyle={[
                styles.heading,
                block.level === 2 ? styles.h2 : styles.h3,
                idx > 0 && { marginTop: 6 },
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
              baseStyle={styles.paragraph}
            />
          );
        }
        if (block.kind === "bullet") {
          return (
            <View key={idx} style={styles.listRow}>
              <Text style={[styles.listBullet, { color: theme.brassText }]}>
                •
              </Text>
              <View style={styles.listContent}>
                <InlineFormattedText
                  text={block.text}
                  theme={theme}
                  baseStyle={styles.listText}
                />
              </View>
            </View>
          );
        }
        if (block.kind === "numbered") {
          return (
            <View key={idx} style={styles.listRow}>
              <Text style={[styles.listNum, { color: theme.brassText }]}>
                {block.num}.
              </Text>
              <View style={styles.listContent}>
                <InlineFormattedText
                  text={block.text}
                  theme={theme}
                  baseStyle={styles.listText}
                />
              </View>
            </View>
          );
        }
        return (
          <SpecNode
            key={idx}
            nodeKey={block.spec.root}
            spec={block.spec}
            theme={theme}
            onReplyButton={onReplyButton}
          />
        );
      })}
    </View>
  );
}

/** Plain clean snippet for Feed stack cards (strips fenced spec & markdown syntax). */
export function feedPreviewText(markdown: string): string {
  return markdown
    .replace(/```spec[\s\S]*?```/g, "")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\s+/g, " ")
    .trim();
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
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
    letterSpacing: -0.2,
  },
  h2: {
    fontSize: 17,
    lineHeight: 23,
  },
  h3: {
    fontSize: 16,
    lineHeight: 22,
  },
  paragraph: {
    fontSize: 15,
    lineHeight: 22.5,
  },
  bold: {
    fontWeight: "700",
  },
  italic: {
    fontStyle: "italic",
  },
  inlineCode: {
    fontFamily: "Courier",
    fontSize: 13.5,
    borderRadius: 4,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingLeft: 2,
  },
  listBullet: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "700",
    width: 12,
    textAlign: "center",
  },
  listNum: {
    fontSize: 14,
    lineHeight: 22,
    fontWeight: "700",
    width: 18,
    fontVariant: ["tabular-nums"],
  },
  listContent: {
    flex: 1,
  },
  listText: {
    fontSize: 15,
    lineHeight: 22,
  },
  specCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    gap: 10,
    marginTop: 2,
  },
  specCardTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  specChildren: {
    gap: 10,
  },
  tableScroll: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  tableCell: {
    fontSize: 12.5,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tableHeaderCell: {
    fontSize: 11.5,
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
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  replySpecBtnText: {
    fontSize: 12.5,
    fontWeight: "600",
  },
});
