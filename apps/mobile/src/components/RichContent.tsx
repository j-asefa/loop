import React, { useMemo, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, {
  Circle,
  Line,
  Path,
  Polyline,
  Rect,
  SvgXml,
} from "react-native-svg";
import { CornerDownRight, ExternalLink } from "lucide-react-native";
import { getAgentArt } from "../agentArt";
import { haptics } from "../haptics";
import type { LoopTheme } from "../theme";

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
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; label: string; url: string };

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern =
    /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(raw);
      if (linkMatch) {
        tokens.push({ kind: "link", label: linkMatch[1], url: linkMatch[2] });
      } else {
        tokens.push({ kind: "text", text: raw });
      }
    } else if (raw.startsWith("**") && raw.endsWith("**")) {
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
        if (tok.kind === "link") {
          return (
            <Text
              key={idx}
              style={{ color: theme.blue, textDecorationLine: "underline" }}
              onPress={() => {
                haptics.light();
                void Linking.openURL(tok.url).catch(() => {});
              }}
            >
              {tok.label}
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
  | { kind: "code"; lang: string; code: string }
  | { kind: "spec"; spec: ParsedSpec };

function parseMarkdownBlocks(content: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
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
    const lang = (match[1] ?? "").toLowerCase();
    const body = match[2] ?? "";
    if (lang === "spec") {
      const parsed = parseSpecBlock(body);
      if (parsed) {
        blocks.push({ kind: "spec", spec: parsed });
      } else {
        blocks.push({ kind: "code", lang: "spec", code: body.trimEnd() });
      }
    } else {
      blocks.push({ kind: "code", lang, code: body.trimEnd() });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    pushMarkdown(content.slice(cursor));
  }
  return blocks;
}

const CHART_COLORS = ["#c9aa4f", "#78cf8a", "#86b0ff", "#e49d64"];

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

  if (el.type === "LinkButton") {
    const label = typeof props.label === "string" ? props.label : "Open link";
    const url = typeof props.url === "string" ? props.url : "";
    if (!/^https?:\/\//i.test(url)) return null;
    return (
      <Pressable
        onPress={() => {
          haptics.light();
          void Linking.openURL(url).catch(() => {});
        }}
        style={({ pressed }) => [
          styles.replySpecBtn,
          {
            backgroundColor: theme.raised,
            borderColor: theme.line,
            opacity: pressed ? 0.78 : 1,
          },
        ]}
      >
        <ExternalLink size={13} color={theme.blue} />
        <Text style={[styles.replySpecBtnText, { color: theme.blue }]}>
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
        if (block.kind === "code") {
          return (
            <View
              key={idx}
              style={[
                styles.codeBlock,
                { backgroundColor: theme.raised, borderColor: theme.line },
              ]}
            >
              {block.lang ? (
                <Text style={[styles.codeLang, { color: theme.muted }]}>
                  {block.lang}
                </Text>
              ) : null}
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={[styles.codeText, { color: theme.text }]}>
                  {block.code}
                </Text>
              </ScrollView>
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
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
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
  codeBlock: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 11,
    gap: 6,
  },
  codeLang: {
    fontSize: 10.5,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  codeText: {
    fontFamily: "Courier",
    fontSize: 12.5,
    lineHeight: 18.5,
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
    padding: 9,
    gap: 3,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  fieldValue: {
    fontSize: 14,
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
    fontSize: 10.5,
    flex: 1,
    textAlign: "center",
  },
  chartToggleBtn: {
    alignSelf: "flex-start",
  },
  chartToggleText: {
    fontSize: 12,
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
    fontSize: 12,
  },
  chartNumVal: {
    fontSize: 12,
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
