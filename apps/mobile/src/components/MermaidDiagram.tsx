import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  Marker,
  Path,
  Polygon,
  Rect,
  Text as SvgText,
  TSpan,
} from "react-native-svg";
import { Check, Code2, Copy, GitBranch } from "lucide-react-native";
import { haptics } from "../haptics";
import {
  measureTextLines,
  parseMermaidDiagram,
  type MermaidFlowLayout,
  type MermaidFlowNode,
  type MermaidMarkerKind,
  type MermaidSequenceLayout,
} from "../mermaid-parser";
import type { LoopTheme } from "../theme";

function edgeEndpoints(
  from: MermaidFlowNode,
  to: MermaidFlowNode,
  direction: MermaidFlowLayout["direction"],
): { x1: number; y1: number; x2: number; y2: number; isBackEdge: boolean } {
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const horizontal = direction === "LR" || direction === "RL";
  const reversed = direction === "BT" || direction === "RL";

  if (horizontal) {
    const isForward = reversed ? tx <= fx : tx >= fx;
    if (tx >= fx) {
      return {
        x1: from.x + from.width,
        y1: fy,
        x2: to.x,
        y2: ty,
        isBackEdge: !isForward,
      };
    }
    return {
      x1: from.x,
      y1: fy,
      x2: to.x + to.width,
      y2: ty,
      isBackEdge: !isForward,
    };
  }

  const isForward = reversed ? ty <= fy : ty >= fy;
  if (ty >= fy) {
    return {
      x1: fx,
      y1: from.y + from.height,
      x2: tx,
      y2: to.y,
      isBackEdge: !isForward,
    };
  }
  return {
    x1: fx,
    y1: from.y,
    x2: tx,
    y2: to.y + to.height,
    isBackEdge: !isForward,
  };
}

function FlowchartSvg({
  layout,
  theme,
}: {
  layout: MermaidFlowLayout;
  theme: LoopTheme;
}) {
  const idBase = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrowId = `ma-${idBase}`;
  const crossId = `mx-${idBase}`;
  const triangleId = `mt-${idBase}`;
  const diamondId = `md-${idBase}`;
  const openDiamondId = `mo-${idBase}`;
  const nodeMap = useMemo(() => {
    const map = new Map<string, MermaidFlowNode>();
    for (const n of layout.nodes) map.set(n.id, n);
    return map;
  }, [layout.nodes]);

  const markerUrl = (
    kind: MermaidMarkerKind | undefined,
    fallbackArrow: boolean,
  ): string | undefined => {
    const resolved = kind ?? (fallbackArrow ? "arrow" : "none");
    if (resolved === "arrow") return `url(#${arrowId})`;
    if (resolved === "cross") return `url(#${crossId})`;
    if (resolved === "triangle") return `url(#${triangleId})`;
    if (resolved === "diamond") return `url(#${diamondId})`;
    if (resolved === "openDiamond") return `url(#${openDiamondId})`;
    return undefined;
  };

  const horizontal = layout.direction === "LR" || layout.direction === "RL";
  const strokeColor = theme.brassText;
  const nodeFill = theme.surface;
  const nodeStroke = theme.attentionLine;

  return (
    <Svg
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      <Defs>
        <Marker
          id={arrowId}
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
        >
          <Path d="M 0 1 L 10 5 L 0 9 z" fill={strokeColor} />
        </Marker>
        <Marker
          id={crossId}
          viewBox="0 0 10 10"
          refX={5}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto"
        >
          <Path
            d="M 2 2 L 8 8 M 8 2 L 2 8"
            stroke={strokeColor}
            strokeWidth={1.8}
          />
        </Marker>
        <Marker
          id={triangleId}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <Path
            d="M 1 1 L 9 5 L 1 9 z"
            fill={nodeFill}
            stroke={strokeColor}
            strokeWidth={1.4}
          />
        </Marker>
        <Marker
          id={diamondId}
          viewBox="0 0 12 10"
          refX={10}
          refY={5}
          markerWidth={8}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <Path d="M 1 5 L 6 1 L 11 5 L 6 9 z" fill={strokeColor} />
        </Marker>
        <Marker
          id={openDiamondId}
          viewBox="0 0 12 10"
          refX={10}
          refY={5}
          markerWidth={8}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <Path
            d="M 1 5 L 6 1 L 11 5 L 6 9 z"
            fill={nodeFill}
            stroke={strokeColor}
            strokeWidth={1.4}
          />
        </Marker>
      </Defs>

      {/* Subgraph containers */}
      {layout.subgraphs.map((sg) => (
        <G key={sg.id}>
          <Rect
            x={sg.x}
            y={sg.y}
            width={sg.width}
            height={sg.height}
            rx={10}
            fill={theme.soft}
            fillOpacity={0.55}
            stroke={theme.line}
            strokeWidth={1.2}
            strokeDasharray="5,4"
          />
          <SvgText
            x={sg.x + 10}
            y={sg.y + 15}
            fontSize={11}
            fontWeight="700"
            fill={theme.muted}
          >
            {sg.label}
          </SvgText>
        </G>
      ))}

      {/* Edges */}
      {layout.edges.map((edge, idx) => {
        if (edge.style === "invisible") return null;
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to) return null;

        let pathD: string;
        let labelX: number;
        let labelY: number;

        if (from.id === to.id) {
          const rx = from.x + from.width;
          const ry = from.y + from.height / 2;
          pathD = `M ${rx} ${ry - 6} C ${rx + 30} ${ry - 24}, ${rx + 30} ${ry + 24}, ${rx} ${ry + 6}`;
          labelX = rx + 26;
          labelY = ry - 4;
        } else {
          const pts = edgeEndpoints(from, to, layout.direction);
          if (pts.isBackEdge) {
            const offset = horizontal ? -34 : 38;
            const cx = (pts.x1 + pts.x2) / 2 + (horizontal ? 0 : offset);
            const cy = (pts.y1 + pts.y2) / 2 + (horizontal ? offset : 0);
            pathD = `M ${pts.x1} ${pts.y1} Q ${cx} ${cy} ${pts.x2} ${pts.y2}`;
            labelX = cx;
            labelY = cy - 4;
          } else if (horizontal) {
            const mx = (pts.x1 + pts.x2) / 2;
            pathD = `M ${pts.x1} ${pts.y1} C ${mx} ${pts.y1}, ${mx} ${pts.y2}, ${pts.x2} ${pts.y2}`;
            labelX = mx;
            labelY = (pts.y1 + pts.y2) / 2 - 5;
          } else {
            const my = (pts.y1 + pts.y2) / 2;
            pathD = `M ${pts.x1} ${pts.y1} C ${pts.x1} ${my}, ${pts.x2} ${my}, ${pts.x2} ${pts.y2}`;
            labelX = (pts.x1 + pts.x2) / 2;
            labelY = my - 4;
          }
        }

        const sw = edge.style === "thick" ? 2.6 : 1.5;
        return (
          <G key={`e-${idx}`}>
            <Path
              d={pathD}
              fill="none"
              stroke={strokeColor}
              strokeWidth={sw}
              strokeDasharray={edge.style === "dashed" ? "5,4" : undefined}
              markerEnd={markerUrl(edge.markerEnd, edge.arrowEnd)}
              markerStart={markerUrl(edge.markerStart, edge.arrowStart)}
            />
            {edge.label ? (
              <G>
                <Rect
                  x={labelX - Math.min(80, edge.label.length * 3.4 + 6)}
                  y={labelY - 10}
                  width={Math.min(160, edge.label.length * 6.8 + 12)}
                  height={16}
                  rx={4}
                  fill={theme.raised}
                />
                <SvgText
                  x={labelX}
                  y={labelY + 1}
                  textAnchor="middle"
                  fontSize={10.5}
                  fontWeight="600"
                  fill={theme.muted}
                >
                  {edge.label.length > 24
                    ? `${edge.label.slice(0, 23)}…`
                    : edge.label}
                </SvgText>
              </G>
            ) : null}
          </G>
        );
      })}

      {/* Nodes */}
      {layout.nodes.map((node) => {
        const cx = node.x + node.width / 2;
        const cy = node.y + node.height / 2;
        const lines = measureTextLines(
          node.label,
          layout.kind === "class" ? 26 : 20,
        );

        if (node.shape === "start") {
          return (
            <Circle
              key={node.id}
              cx={cx}
              cy={cy}
              r={10}
              fill={theme.brass}
              stroke={strokeColor}
              strokeWidth={1.5}
            />
          );
        }

        if (node.shape === "end") {
          return (
            <G key={node.id}>
              <Circle
                cx={cx}
                cy={cy}
                r={12}
                fill={nodeFill}
                stroke={strokeColor}
                strokeWidth={2}
              />
              <Circle cx={cx} cy={cy} r={6} fill={theme.brass} />
            </G>
          );
        }

        if (node.shape === "diamond") {
          const pts = `${cx},${node.y} ${node.x + node.width},${cy} ${cx},${node.y + node.height} ${node.x},${cy}`;
          const startY = cy - ((lines.length - 1) * 14) / 2 + 4;
          return (
            <G key={node.id}>
              <Polygon
                points={pts}
                fill={theme.attention}
                stroke={nodeStroke}
                strokeWidth={1.5}
              />
              <SvgText
                x={cx}
                y={startY}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight="600"
                fill={theme.text}
              >
                {lines.map((line, lIdx) => (
                  <TSpan key={lIdx} x={cx} dy={lIdx === 0 ? 0 : 14}>
                    {line}
                  </TSpan>
                ))}
              </SvgText>
            </G>
          );
        }

        if (node.shape === "circle") {
          const r = node.width / 2;
          const startY = cy - ((lines.length - 1) * 14) / 2 + 4;
          return (
            <G key={node.id}>
              <Circle
                cx={cx}
                cy={cy}
                r={r}
                fill={nodeFill}
                stroke={nodeStroke}
                strokeWidth={1.5}
              />
              <SvgText
                x={cx}
                y={startY}
                textAnchor="middle"
                fontSize={11.5}
                fontWeight="600"
                fill={theme.text}
              >
                {lines.map((line, lIdx) => (
                  <TSpan key={lIdx} x={cx} dy={lIdx === 0 ? 0 : 14}>
                    {line}
                  </TSpan>
                ))}
              </SvgText>
            </G>
          );
        }

        if (
          layout.kind === "class" &&
          node.members &&
          node.members.length > 0
        ) {
          const headerH = 26 + Math.max(0, lines.length - 1) * 14;
          return (
            <G key={node.id}>
              <Rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={8}
                fill={nodeFill}
                stroke={nodeStroke}
                strokeWidth={1.5}
              />
              <Rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={headerH}
                rx={8}
                fill={theme.attention}
              />
              <Line
                x1={node.x}
                y1={node.y + headerH}
                x2={node.x + node.width}
                y2={node.y + headerH}
                stroke={nodeStroke}
                strokeWidth={1}
              />
              <SvgText
                x={cx}
                y={node.y + 17}
                textAnchor="middle"
                fontSize={12}
                fontWeight="700"
                fill={theme.brassText}
              >
                {lines[0]}
              </SvgText>
              {node.members.slice(0, 8).map((member, mIdx) => (
                <SvgText
                  key={mIdx}
                  x={node.x + 10}
                  y={node.y + headerH + 15 + mIdx * 15}
                  fontSize={10.5}
                  fill={theme.text}
                >
                  {member.length > 30 ? `${member.slice(0, 29)}…` : member}
                </SvgText>
              ))}
            </G>
          );
        }

        const rx =
          node.shape === "stadium"
            ? node.height / 2
            : node.shape === "rounded" || node.shape === "cylinder"
              ? 12
              : 6;
        const startY = cy - ((lines.length - 1) * 15) / 2 + 4;
        return (
          <G key={node.id}>
            <Rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={rx}
              fill={nodeFill}
              stroke={nodeStroke}
              strokeWidth={1.5}
            />
            {node.shape === "subroutine" && (
              <>
                <Line
                  x1={node.x + 7}
                  y1={node.y}
                  x2={node.x + 7}
                  y2={node.y + node.height}
                  stroke={nodeStroke}
                  strokeWidth={1.2}
                />
                <Line
                  x1={node.x + node.width - 7}
                  y1={node.y}
                  x2={node.x + node.width - 7}
                  y2={node.y + node.height}
                  stroke={nodeStroke}
                  strokeWidth={1.2}
                />
              </>
            )}
            <SvgText
              x={cx}
              y={startY}
              textAnchor="middle"
              fontSize={12}
              fontWeight="600"
              fill={theme.text}
            >
              {lines.map((line, lIdx) => (
                <TSpan key={lIdx} x={cx} dy={lIdx === 0 ? 0 : 15}>
                  {line}
                </TSpan>
              ))}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

function SequenceSvg({
  layout,
  theme,
}: {
  layout: MermaidSequenceLayout;
  theme: LoopTheme;
}) {
  const idBase = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const seqArrowId = `sa-${idBase}`;
  const seqCrossId = `sx-${idBase}`;
  const xById = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of layout.participants) map.set(p.id, p.x);
    return map;
  }, [layout.participants]);

  const topY = 18;
  const strokeColor = theme.brassText;

  return (
    <Svg
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      <Defs>
        <Marker
          id={seqArrowId}
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto"
        >
          <Path d="M 0 1 L 10 5 L 0 9 z" fill={strokeColor} />
        </Marker>
        <Marker
          id={seqCrossId}
          viewBox="0 0 10 10"
          refX={5}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto"
        >
          <Path
            d="M 2 2 L 8 8 M 8 2 L 2 8"
            stroke={strokeColor}
            strokeWidth={1.8}
          />
        </Marker>
      </Defs>

      {/* Lifelines + participant headers */}
      {layout.participants.map((p) => (
        <G key={p.id}>
          <Line
            x1={p.x}
            y1={topY + layout.headerHeight}
            x2={p.x}
            y2={layout.lifelineBottom}
            stroke={theme.line}
            strokeWidth={1.4}
            strokeDasharray="4,4"
          />
          <Rect
            x={p.x - p.width / 2}
            y={topY}
            width={p.width}
            height={layout.headerHeight}
            rx={p.isActor ? layout.headerHeight / 2 : 8}
            fill={theme.surface}
            stroke={theme.attentionLine}
            strokeWidth={1.5}
          />
          <SvgText
            x={p.x}
            y={topY + layout.headerHeight / 2 + 4}
            textAnchor="middle"
            fontSize={12}
            fontWeight="700"
            fill={theme.text}
          >
            {p.label.length > 18 ? `${p.label.slice(0, 17)}…` : p.label}
          </SvgText>
        </G>
      ))}

      {/* Messages & Notes */}
      {layout.steps.map((step, idx) => {
        const x1 = xById.get(step.from);
        const x2 = xById.get(step.to);
        if (x1 === undefined || x2 === undefined) return null;

        if (step.kind === "note") {
          const left = Math.min(x1, x2) - 44;
          const width = Math.max(88, Math.abs(x2 - x1) + 88);
          return (
            <G key={`s-${idx}`}>
              <Rect
                x={left}
                y={step.y - 12}
                width={width}
                height={24}
                rx={6}
                fill={theme.attention}
                stroke={theme.attentionLine}
                strokeWidth={1}
              />
              <SvgText
                x={left + width / 2}
                y={step.y + 4}
                textAnchor="middle"
                fontSize={11}
                fontWeight="600"
                fill={theme.brassText}
              >
                {step.text.length > 28
                  ? `${step.text.slice(0, 27)}…`
                  : step.text}
              </SvgText>
            </G>
          );
        }

        const headUrl =
          step.head === "arrow"
            ? `url(#${seqArrowId})`
            : step.head === "cross"
              ? `url(#${seqCrossId})`
              : undefined;

        if (x1 === x2) {
          const pathD = `M ${x1} ${step.y} H ${x1 + 36} V ${step.y + 20} H ${x1 + 2}`;
          return (
            <G key={`s-${idx}`}>
              <Path
                d={pathD}
                fill="none"
                stroke={strokeColor}
                strokeWidth={1.5}
                strokeDasharray={step.dashed ? "5,4" : undefined}
                markerEnd={headUrl}
              />
              {step.label ? (
                <SvgText
                  x={x1 + 40}
                  y={step.y + 13}
                  fontSize={11}
                  fontWeight="600"
                  fill={theme.text}
                >
                  {step.label.length > 22
                    ? `${step.label.slice(0, 21)}…`
                    : step.label}
                </SvgText>
              ) : null}
            </G>
          );
        }

        const dir = x2 > x1 ? 1 : -1;
        const midX = (x1 + x2) / 2;
        return (
          <G key={`s-${idx}`}>
            <Line
              x1={x1}
              y1={step.y}
              x2={x2 - dir * 3}
              y2={step.y}
              stroke={strokeColor}
              strokeWidth={1.5}
              strokeDasharray={step.dashed ? "5,4" : undefined}
              markerEnd={headUrl}
            />
            {step.label ? (
              <SvgText
                x={midX}
                y={step.y - 6}
                textAnchor="middle"
                fontSize={11}
                fontWeight="600"
                fill={theme.text}
              >
                {step.label.length > 26
                  ? `${step.label.slice(0, 25)}…`
                  : step.label}
              </SvgText>
            ) : null}
          </G>
        );
      })}
    </Svg>
  );
}

export function MermaidDiagram({
  code,
  theme,
}: {
  code: string;
  theme: LoopTheme;
}) {
  const layout = useMemo(() => parseMermaidDiagram(code), [code]);
  const [showSource, setShowSource] = useState(false);
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

  const showingDiagram = Boolean(layout) && !showSource;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.raised, borderColor: theme.line },
      ]}
    >
      <View style={styles.headRow}>
        <View style={styles.headLeft}>
          <GitBranch size={12} color={theme.brassText} />
          <Text style={[styles.kindText, { color: theme.brassText }]}>
            {layout ? `mermaid · ${layout.kind}` : "mermaid"}
          </Text>
        </View>
        <View style={styles.headActions}>
          {layout && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                showSource ? "Show diagram" : "Show Mermaid source"
              }
              hitSlop={6}
              onPress={() => {
                haptics.selection();
                setShowSource((v) => !v);
              }}
              style={[
                styles.actionBtn,
                { backgroundColor: theme.soft, borderColor: theme.line },
              ]}
            >
              <Code2 size={12} color={theme.muted} />
              <Text style={[styles.actionText, { color: theme.muted }]}>
                {showSource ? "Diagram" : "Source"}
              </Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? "Mermaid copied" : "Copy Mermaid"}
            hitSlop={6}
            onPress={handleCopy}
            style={[
              styles.actionBtn,
              {
                backgroundColor: theme.soft,
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
                styles.actionText,
                { color: copied ? theme.brassText : theme.muted },
              ]}
            >
              {copied ? "Copied" : "Copy"}
            </Text>
          </Pressable>
        </View>
      </View>

      {showingDiagram && layout ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.svgScrollContent}
        >
          {layout.kind === "sequence" ? (
            <SequenceSvg layout={layout} theme={theme} />
          ) : (
            <FlowchartSvg layout={layout} theme={theme} />
          )}
        </ScrollView>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={[styles.sourceText, { color: theme.text }]}>{code}</Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  headLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  kindText: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  headActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionText: {
    fontSize: 11,
    fontWeight: "600",
  },
  svgScrollContent: {
    paddingVertical: 2,
  },
  sourceText: {
    fontFamily: "Courier",
    fontSize: 13,
    lineHeight: 19,
  },
});
