export const MAX_MERMAID_SOURCE_CHARS = 32_000;
export const MAX_MERMAID_NODES = 80;
export const MAX_MERMAID_EDGES = 160;
export const MAX_MERMAID_SEQUENCE_STEPS = 100;

export type MermaidDirection = "TD" | "TB" | "LR" | "RL" | "BT";

export type MermaidNodeShape =
  | "rect"
  | "rounded"
  | "stadium"
  | "diamond"
  | "circle"
  | "subroutine"
  | "cylinder"
  | "start"
  | "end";

export type MermaidFlowNode = {
  id: string;
  label: string;
  shape: MermaidNodeShape;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  members?: string[];
};

export type MermaidMarkerKind =
  "none" | "arrow" | "cross" | "triangle" | "diamond" | "openDiamond";

export type MermaidFlowEdge = {
  from: string;
  to: string;
  label?: string;
  style: "solid" | "dashed" | "thick";
  arrowEnd: boolean;
  arrowStart: boolean;
  markerStart?: MermaidMarkerKind;
  markerEnd?: MermaidMarkerKind;
};

export type MermaidSubgraph = {
  id: string;
  label: string;
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MermaidFlowLayout = {
  kind: "flowchart" | "state" | "class";
  direction: MermaidDirection;
  width: number;
  height: number;
  nodes: MermaidFlowNode[];
  edges: MermaidFlowEdge[];
  subgraphs: MermaidSubgraph[];
};

export type MermaidSequenceParticipant = {
  id: string;
  label: string;
  isActor: boolean;
  x: number;
  width: number;
};

export type MermaidSequenceStep =
  | {
      kind: "message";
      from: string;
      to: string;
      label: string;
      dashed: boolean;
      arrow: boolean;
      head: "arrow" | "cross" | "none";
      y: number;
    }
  | {
      kind: "note";
      from: string;
      to: string;
      text: string;
      y: number;
    };

export type MermaidSequenceLayout = {
  kind: "sequence";
  width: number;
  height: number;
  headerHeight: number;
  lifelineBottom: number;
  participants: MermaidSequenceParticipant[];
  steps: MermaidSequenceStep[];
};

export type MermaidLayout = MermaidFlowLayout | MermaidSequenceLayout;

function cleanLabel(raw: string): string {
  let text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    text = text.slice(1, -1);
  }
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

function measureTextLines(label: string, maxCharsPerLine = 22): string[] {
  const paragraphs = label.split("\n");
  const out: string[] = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxCharsPerLine) {
      out.push(trimmed);
      continue;
    }
    const words = trimmed.split(/\s+/);
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
      } else if (current.length + 1 + word.length <= maxCharsPerLine) {
        current += ` ${word}`;
      } else {
        out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out.length > 0 ? out.slice(0, 5) : [""];
}

function stripLineComment(rawLine: string): string {
  let inDoubleQuote = false;
  for (let i = 0; i < rawLine.length - 1; i += 1) {
    const ch = rawLine[i];
    if (inDoubleQuote) {
      if (ch === "\\" && i + 1 < rawLine.length) {
        i += 1;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "%" && rawLine[i + 1] === "%") {
      return rawLine.slice(0, i).trim();
    }
  }
  return rawLine.trim();
}

function stripInitDirectives(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf("%%{", i);
    if (start === -1) {
      out += source.slice(i);
      break;
    }
    const end = source.indexOf("}%%", start + 3);
    if (end === -1) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, start);
    i = end + 3;
  }
  return out;
}

function splitTopLevelDelimiter(segment: string, delim: string): string[] {
  const parts: string[] = [];
  let bracketDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let inDoubleQuote = false;
  let start = 0;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (inDoubleQuote) {
      if (ch === "\\" && i + 1 < segment.length) {
        i += 1;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (
      ch === delim &&
      bracketDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0
    ) {
      parts.push(segment.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(segment.slice(start));
  return parts;
}

function preprocessLines(source: string): string[] {
  const capped =
    source.length > MAX_MERMAID_SOURCE_CHARS
      ? source.slice(0, MAX_MERMAID_SOURCE_CHARS)
      : source;
  const withoutDirectives = stripInitDirectives(capped);
  const out: string[] = [];
  for (const rawLine of withoutDirectives.replace(/\r\n/g, "\n").split("\n")) {
    const stripped = stripLineComment(rawLine);
    if (stripped) out.push(stripped);
  }
  return out;
}

type RawNode = {
  id: string;
  label: string;
  shape: MermaidNodeShape;
  members?: string[];
};

const NODE_TOKEN_PATTERNS: Array<{
  shape: MermaidNodeShape;
  open: string;
  close: string;
}> = [
  { shape: "stadium", open: "([", close: "])" },
  { shape: "circle", open: "((", close: "))" },
  { shape: "subroutine", open: "[[", close: "]]" },
  { shape: "cylinder", open: "[(", close: ")]" },
  { shape: "rect", open: "[", close: "]" },
  { shape: "rounded", open: "(", close: ")" },
  { shape: "diamond", open: "{", close: "}" },
];

function parseNodeSpec(
  rawToken: string,
): { id: string; label?: string; shape?: MermaidNodeShape } | null {
  const token = rawToken.trim().replace(/;+$/, "").trim();
  if (!token) return null;
  // Match leading identifier
  const idMatch = /^([A-Za-z0-9_.-]+)(.*)$/.exec(token);
  if (!idMatch) return null;
  const id = idMatch[1];
  const rest = idMatch[2].trim();
  if (!rest) return { id };
  for (const pat of NODE_TOKEN_PATTERNS) {
    if (rest.startsWith(pat.open) && rest.endsWith(pat.close)) {
      const inner = rest.slice(pat.open.length, rest.length - pat.close.length);
      return {
        id,
        label: cleanLabel(inner) || id,
        shape: pat.shape,
      };
    }
  }
  return { id };
}

type ParsedConnector = {
  index: number;
  length: number;
  style: "solid" | "dashed" | "thick";
  arrowEnd: boolean;
  arrowStart: boolean;
  markerStart?: MermaidMarkerKind;
  markerEnd?: MermaidMarkerKind;
  label?: string;
};

function matchInlineLabeledConnector(
  line: string,
  index: number,
): ParsedConnector | null {
  const specs: Array<{
    open: string;
    style: "solid" | "dashed" | "thick";
    forbidChar: string;
    closers: Array<{ token: string; arrowEnd: boolean }>;
  }> = [
    {
      open: "--",
      style: "solid",
      forbidChar: "-",
      closers: [
        { token: "-->", arrowEnd: true },
        { token: "---", arrowEnd: false },
      ],
    },
    {
      open: "-.",
      style: "dashed",
      forbidChar: ".",
      closers: [
        { token: ".->", arrowEnd: true },
        { token: ".-", arrowEnd: false },
      ],
    },
    {
      open: "==",
      style: "thick",
      forbidChar: "=",
      closers: [
        { token: "==>", arrowEnd: true },
        { token: "===", arrowEnd: false },
      ],
    },
  ];

  for (const spec of specs) {
    if (!line.startsWith(spec.open, index)) continue;
    const afterOpen = index + spec.open.length;
    if (line[afterOpen] !== " " && line[afterOpen] !== "\t") continue;
    let labelStart = afterOpen;
    while (
      labelStart < line.length &&
      (line[labelStart] === " " || line[labelStart] === "\t")
    ) {
      labelStart += 1;
    }
    if (labelStart >= line.length) continue;

    // Linear scan for the nearest closing connector token
    let bestIdx = -1;
    let bestCloser: { token: string; arrowEnd: boolean } | null = null;
    for (const closer of spec.closers) {
      const idx = line.indexOf(closer.token, labelStart);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestCloser = closer;
      }
    }
    if (bestIdx === -1 || !bestCloser) continue;
    if (line[bestIdx - 1] !== " " && line[bestIdx - 1] !== "\t") continue;
    const rawLabel = line.slice(labelStart, bestIdx).trim();
    if (!rawLabel || rawLabel.includes(spec.forbidChar)) continue;
    return {
      index,
      length: bestIdx + bestCloser.token.length - index,
      style: spec.style,
      arrowStart: false,
      arrowEnd: bestCloser.arrowEnd,
      label: cleanLabel(rawLabel),
    };
  }
  return null;
}
function findNextConnector(
  line: string,
  startFrom = 0,
): ParsedConnector | null {
  let bracketDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let inDoubleQuote = false;

  for (let i = startFrom; i < line.length; i += 1) {
    const ch = line[i];
    if (inDoubleQuote) {
      if (ch === "\\" && i + 1 < line.length) {
        i += 1;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (bracketDepth > 0 || parenDepth > 0 || braceDepth > 0) continue;

    // Linear O(N) scan for inline labeled connectors (-- text -->, -. text .->, == text ==>)
    const inlineConn = matchInlineLabeledConnector(line, i);
    if (inlineConn) return inlineConn;

    const slice = line.slice(i);
    // Standard connectors (including --x, x--x, --o, o--o, ~~~) with optional |label|
    const arrowMatch =
      /^(<-->|<-\.->|<==>|x--+x|o--+o|-\.+->|-\.+-|==+>|===+|--+>|--+x|--+o|---+|~~~+)(\s*\|([^|\n]+)\|)?/.exec(
        slice,
      );
    if (arrowMatch) {
      const sym = arrowMatch[1];
      const style: "solid" | "dashed" | "thick" =
        sym.includes(".") || sym.startsWith("~")
          ? "dashed"
          : sym.includes("=")
            ? "thick"
            : "solid";
      const markerStart: MermaidMarkerKind = sym.startsWith("<")
        ? "arrow"
        : sym.startsWith("x")
          ? "cross"
          : sym.startsWith("o")
            ? "openDiamond"
            : "none";
      const markerEnd: MermaidMarkerKind = sym.endsWith(">")
        ? "arrow"
        : sym.endsWith("x")
          ? "cross"
          : sym.endsWith("o")
            ? "openDiamond"
            : "none";
      return {
        index: i,
        length: arrowMatch[0].length,
        style,
        arrowStart: markerStart === "arrow",
        arrowEnd: markerEnd === "arrow",
        markerStart,
        markerEnd,
        label: arrowMatch[3] ? cleanLabel(arrowMatch[3]) : undefined,
      };
    }
  }
  return null;
}

function layoutGraph(
  kind: "flowchart" | "state" | "class",
  direction: MermaidDirection,
  rawNodes: Map<string, RawNode>,
  edges: MermaidFlowEdge[],
  rawSubgraphs: Array<{ id: string; label: string; nodeIds: string[] }>,
): MermaidFlowLayout | null {
  if (rawNodes.size === 0) return null;

  const nodeIds = Array.from(rawNodes.keys());
  const outgoing = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of edges) {
    if (!rawNodes.has(e.from) || !rawNodes.has(e.to) || e.from === e.to) {
      continue;
    }
    outgoing.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // Kahn-based layering with cycle fallback so back-edges never loop infinitely.
  const layerById = new Map<string, number>();
  const remainingIn = new Map(inDegree);
  const queue: string[] = [];
  for (const id of nodeIds) {
    if ((remainingIn.get(id) ?? 0) === 0) {
      queue.push(id);
      layerById.set(id, 0);
    }
  }

  let cursor = 0;
  const processed = new Set<string>();
  while (processed.size < nodeIds.length) {
    if (cursor >= queue.length) {
      // Break cycle by picking the first unprocessed node with minimum remaining in-degree.
      let pick = "";
      let minDeg = Number.POSITIVE_INFINITY;
      for (const id of nodeIds) {
        if (processed.has(id)) continue;
        const deg = remainingIn.get(id) ?? 0;
        if (deg < minDeg) {
          minDeg = deg;
          pick = id;
        }
      }
      if (!pick) break;
      if (!layerById.has(pick)) layerById.set(pick, 0);
      queue.push(pick);
    }
    const current = queue[cursor++];
    if (processed.has(current)) continue;
    processed.add(current);
    const curLayer = layerById.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      if (processed.has(next)) continue;
      const candidate = curLayer + 1;
      if (candidate > (layerById.get(next) ?? -1)) {
        layerById.set(next, candidate);
      }
      const nextDeg = (remainingIn.get(next) ?? 1) - 1;
      remainingIn.set(next, nextDeg);
      if (nextDeg <= 0) {
        queue.push(next);
      }
    }
  }

  const maxLayer = Math.max(0, ...Array.from(layerById.values()));
  const reversed = direction === "BT" || direction === "RL";
  const horizontal = direction === "LR" || direction === "RL";

  // Compute each node's box dimensions from its label and optional class members.
  const sizeById = new Map<string, { width: number; height: number }>();
  for (const [id, node] of rawNodes) {
    if (node.shape === "start" || node.shape === "end") {
      sizeById.set(id, { width: 26, height: 26 });
      continue;
    }
    const lines = measureTextLines(node.label, kind === "class" ? 26 : 20);
    const maxLen = Math.max(
      ...lines.map((l) => l.length),
      ...(node.members ?? []).map((m) => Math.min(30, m.length)),
    );
    const charW = 7.4;
    if (node.shape === "diamond") {
      const w = Math.max(96, Math.min(200, Math.round(maxLen * charW + 44)));
      const h = Math.max(54, lines.length * 16 + 30);
      sizeById.set(id, { width: w, height: h });
    } else if (node.shape === "circle") {
      const d = Math.max(56, Math.min(116, Math.round(maxLen * charW + 24)));
      sizeById.set(id, { width: d, height: d });
    } else if (kind === "class" && node.members && node.members.length > 0) {
      const w = Math.max(130, Math.min(240, Math.round(maxLen * charW + 28)));
      const h =
        28 + lines.length * 15 + Math.min(node.members.length, 8) * 15 + 14;
      sizeById.set(id, { width: w, height: h });
    } else {
      const w = Math.max(92, Math.min(210, Math.round(maxLen * charW + 28)));
      const h = Math.max(40, lines.length * 16 + 20);
      sizeById.set(id, { width: w, height: h });
    }
  }

  // Group nodes by effective visual layer
  const layers = new Map<number, string[]>();
  for (const id of nodeIds) {
    const rawL = layerById.get(id) ?? 0;
    const effL = reversed ? maxLayer - rawL : rawL;
    const bucket = layers.get(effL) ?? [];
    bucket.push(id);
    layers.set(effL, bucket);
  }

  const PAD = 24;
  const SUBGRAPH_PAD = 16;
  const LAYER_GAP = horizontal ? 64 : 52;
  const SIBLING_GAP = horizontal ? 24 : 26;

  // Compute per-layer thickness and total cross-axis span
  const layerDepths: number[] = [];
  const layerSpans: number[] = [];
  for (let l = 0; l <= maxLayer; l += 1) {
    const ids = layers.get(l) ?? [];
    let maxDepth = 0;
    let totalSpan = 0;
    ids.forEach((id, idx) => {
      const sz = sizeById.get(id)!;
      if (horizontal) {
        maxDepth = Math.max(maxDepth, sz.width);
        totalSpan += sz.height + (idx > 0 ? SIBLING_GAP : 0);
      } else {
        maxDepth = Math.max(maxDepth, sz.height);
        totalSpan += sz.width + (idx > 0 ? SIBLING_GAP : 0);
      }
    });
    layerDepths.push(maxDepth);
    layerSpans.push(totalSpan);
  }

  const maxCrossSpan = Math.max(120, ...layerSpans);
  const placedNodes: MermaidFlowNode[] = [];
  const placedById = new Map<string, MermaidFlowNode>();

  let primaryCursor = PAD + (rawSubgraphs.length > 0 ? 18 : 0);
  for (let l = 0; l <= maxLayer; l += 1) {
    const ids = layers.get(l) ?? [];
    const span = layerSpans[l];
    const depth = layerDepths[l];
    let crossCursor = PAD + Math.max(0, (maxCrossSpan - span) / 2);

    for (const id of ids) {
      const raw = rawNodes.get(id)!;
      const sz = sizeById.get(id)!;
      const x = horizontal
        ? Math.round(primaryCursor + (depth - sz.width) / 2)
        : Math.round(crossCursor);
      const y = horizontal
        ? Math.round(crossCursor)
        : Math.round(primaryCursor + (depth - sz.height) / 2);
      const node: MermaidFlowNode = {
        id,
        label: raw.label,
        shape: raw.shape,
        x,
        y,
        width: sz.width,
        height: sz.height,
        layer: l,
        ...(raw.members ? { members: raw.members } : {}),
      };
      placedNodes.push(node);
      placedById.set(id, node);
      crossCursor += (horizontal ? sz.height : sz.width) + SIBLING_GAP;
    }

    primaryCursor += depth + LAYER_GAP;
  }

  // Compute subgraph bounding boxes around their member nodes
  const subgraphs: MermaidSubgraph[] = [];
  for (const sg of rawSubgraphs) {
    const members = sg.nodeIds
      .map((id) => placedById.get(id))
      .filter((n): n is MermaidFlowNode => Boolean(n));
    if (members.length === 0) continue;
    const minX = Math.min(...members.map((n) => n.x)) - SUBGRAPH_PAD;
    const minY = Math.min(...members.map((n) => n.y)) - SUBGRAPH_PAD - 16;
    const maxX = Math.max(...members.map((n) => n.x + n.width)) + SUBGRAPH_PAD;
    const maxY = Math.max(...members.map((n) => n.y + n.height)) + SUBGRAPH_PAD;
    subgraphs.push({
      id: sg.id,
      label: sg.label,
      nodeIds: sg.nodeIds,
      x: Math.max(8, minX),
      y: Math.max(8, minY),
      width: maxX - Math.max(8, minX),
      height: maxY - Math.max(8, minY),
    });
  }

  const maxRight = Math.max(
    ...placedNodes.map((n) => n.x + n.width),
    ...subgraphs.map((s) => s.x + s.width),
  );
  const maxBottom = Math.max(
    ...placedNodes.map((n) => n.y + n.height),
    ...subgraphs.map((s) => s.y + s.height),
  );

  return {
    kind,
    direction,
    width: Math.max(220, Math.round(maxRight + PAD)),
    height: Math.max(120, Math.round(maxBottom + PAD)),
    nodes: placedNodes,
    edges,
    subgraphs,
  };
}

function parseFlowchart(lines: string[]): MermaidFlowLayout | null {
  const header = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*;?$/i.exec(
    lines[0],
  );
  if (!header) return null;
  const direction = (header[1] || "TD").toUpperCase() as MermaidDirection;

  const nodes = new Map<string, RawNode>();
  const edges: MermaidFlowEdge[] = [];
  const subgraphs: Array<{ id: string; label: string; nodeIds: string[] }> = [];
  const subgraphStack: Array<{ id: string; label: string; nodeIds: string[] }> =
    [];

  const ensureNode = (spec: {
    id: string;
    label?: string;
    shape?: MermaidNodeShape;
  }): string | null => {
    const existing = nodes.get(spec.id);
    if (existing) {
      if (spec.label && existing.label === existing.id) {
        existing.label = spec.label;
      }
      if (spec.shape && existing.shape === "rect") {
        existing.shape = spec.shape;
      }
    } else {
      if (nodes.size >= MAX_MERMAID_NODES) return null;
      nodes.set(spec.id, {
        id: spec.id,
        label: spec.label || spec.id,
        shape: spec.shape || "rect",
      });
    }
    for (const sg of subgraphStack) {
      if (!sg.nodeIds.includes(spec.id)) sg.nodeIds.push(spec.id);
    }
    return spec.id;
  };

  for (let i = 1; i < lines.length; i += 1) {
    for (const rawStmt of splitTopLevelDelimiter(lines[i], ";")) {
      const line = rawStmt.trim();
      if (!line) continue;
      if (/^(?:classDef|class|style|linkStyle|click|direction)\b/i.test(line)) {
        continue;
      }
      const sgMatch = /^subgraph\s+(.+)$/i.exec(line);
      if (sgMatch) {
        const rest = sgMatch[1].trim();
        const bracketLabel = /^([A-Za-z0-9_.-]+)\s*\[(.+)\]$/.exec(rest);
        const sg = {
          id: bracketLabel ? bracketLabel[1] : `sg-${subgraphs.length + 1}`,
          label: cleanLabel(bracketLabel ? bracketLabel[2] : rest),
          nodeIds: [] as string[],
        };
        subgraphs.push(sg);
        subgraphStack.push(sg);
        continue;
      }
      if (/^end$/i.test(line)) {
        subgraphStack.pop();
        continue;
      }

      // Split statement on connectors (supporting chains like A --> B --> C and & fan-out)
      let cursor = 0;
      let prevGroup: string[] = [];
      let pendingConn: ParsedConnector | null = null;
      let foundConnector = false;

      while (cursor < line.length) {
        const conn = findNextConnector(line, cursor);
        const segment = (
          conn ? line.slice(cursor, conn.index) : line.slice(cursor)
        ).trim();

        const groupIds: string[] = [];
        const seenInGroup = new Set<string>();
        for (const part of splitTopLevelDelimiter(segment, "&")) {
          const parsed = parseNodeSpec(part);
          if (parsed) {
            const id = ensureNode(parsed);
            if (id && !seenInGroup.has(id)) {
              seenInGroup.add(id);
              groupIds.push(id);
            }
          }
        }

        if (pendingConn && prevGroup.length > 0 && groupIds.length > 0) {
          outer: for (const from of prevGroup) {
            for (const to of groupIds) {
              if (edges.length >= MAX_MERMAID_EDGES) break outer;
              edges.push({
                from,
                to,
                ...(pendingConn.label ? { label: pendingConn.label } : {}),
                style: pendingConn.style,
                arrowStart: pendingConn.arrowStart,
                arrowEnd: pendingConn.arrowEnd,
                ...(pendingConn.markerStart
                  ? { markerStart: pendingConn.markerStart }
                  : {}),
                ...(pendingConn.markerEnd
                  ? { markerEnd: pendingConn.markerEnd }
                  : {}),
              });
            }
          }
        }

        if (groupIds.length > 0) {
          prevGroup = groupIds;
        }

        if (!conn) break;
        foundConnector = true;
        pendingConn = conn;
        cursor = conn.index + conn.length;
      }

      if (!foundConnector && prevGroup.length === 0) {
        const standalone = parseNodeSpec(line);
        if (standalone) ensureNode(standalone);
      }
    }
  }

  return layoutGraph("flowchart", direction, nodes, edges, subgraphs);
}

function parseSequence(lines: string[]): MermaidSequenceLayout | null {
  if (!/^sequenceDiagram\b/i.test(lines[0])) return null;

  const participantOrder: string[] = [];
  const participantMap = new Map<
    string,
    { id: string; label: string; isActor: boolean }
  >();
  const rawSteps: Array<
    | {
        kind: "message";
        from: string;
        to: string;
        label: string;
        dashed: boolean;
        arrow: boolean;
        head: "arrow" | "cross" | "none";
      }
    | { kind: "note"; from: string; to: string; text: string }
  > = [];

  const ensureParticipant = (id: string, label?: string, isActor = false) => {
    const cleanId = id.trim();
    if (!cleanId) return;
    const existing = participantMap.get(cleanId);
    if (existing) {
      if (label) existing.label = cleanLabel(label);
      if (isActor) existing.isActor = true;
      return;
    }
    if (participantOrder.length >= MAX_MERMAID_NODES) return;
    participantOrder.push(cleanId);
    participantMap.set(cleanId, {
      id: cleanId,
      label: cleanLabel(label || cleanId),
      isActor,
    });
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    // Fall back to Mermaid source when branching/loop control blocks appear so
    // conditional or repeated messages are never flattened into linear arrows.
    // Require whitespace or EOL after keyword so participant names like Option->>API still parse.
    if (
      /^(?:alt|else|opt|par|and|critical|option|break|loop)(?:\s|$)/i.test(line)
    ) {
      return null;
    }
    if (/^(?:autonumber|rect|end|activate|deactivate)(?:\s|$)/i.test(line)) {
      continue;
    }
    const decl = /^(participant|actor)\s+([^\s:]+)(?:\s+as\s+(.+))?$/i.exec(
      line,
    );
    if (decl) {
      ensureParticipant(
        decl[2],
        decl[3] || decl[2],
        decl[1].toLowerCase() === "actor",
      );
      continue;
    }

    // Linear parse for `Note right of|left of|over Target[,Target2] : text` (no overlapping quantifiers)
    const notePrefix = /^Note\s+(?:right of|left of|over)\s+/i.exec(line);
    if (notePrefix && rawSteps.length < MAX_MERMAID_SEQUENCE_STEPS) {
      const colonIdx = line.indexOf(":", notePrefix[0].length);
      if (colonIdx !== -1) {
        const targetSpec = line.slice(notePrefix[0].length, colonIdx).trim();
        const noteText = line.slice(colonIdx + 1).trim();
        const targets = targetSpec
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const from = targets[0];
        const to = targets[targets.length - 1] || from;
        if (from && noteText) {
          ensureParticipant(from);
          if (to !== from) ensureParticipant(to);
          rawSteps.push({
            kind: "note",
            from,
            to,
            text: cleanLabel(noteText),
          });
        }
        continue;
      }
    }

    const msgMatch =
      /^([^\s:-]+)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?([^\s:]+)\s*:\s*(.*)$/.exec(
        line,
      );
    if (msgMatch && rawSteps.length < MAX_MERMAID_SEQUENCE_STEPS) {
      const from = msgMatch[1].trim();
      const op = msgMatch[2];
      const to = msgMatch[3].trim();
      const label = cleanLabel(msgMatch[4]);
      ensureParticipant(from);
      ensureParticipant(to);
      const head: "arrow" | "cross" | "none" =
        op.endsWith(">>") || op.endsWith(")")
          ? "arrow"
          : op.endsWith("x")
            ? "cross"
            : "none";
      rawSteps.push({
        kind: "message",
        from,
        to,
        label,
        dashed: op.startsWith("--"),
        arrow: head === "arrow",
        head,
      });
    }
  }

  if (participantOrder.length === 0) return null;

  const PAD = 22;
  const HEADER_H = 38;
  const COL_GAP = 26;
  const STEP_H = 44;

  const participants: MermaidSequenceParticipant[] = [];
  let cursorX = PAD;
  for (const id of participantOrder) {
    const info = participantMap.get(id)!;
    const width = Math.max(
      88,
      Math.min(168, Math.round(info.label.length * 7.5 + 26)),
    );
    participants.push({
      id: info.id,
      label: info.label,
      isActor: info.isActor,
      x: Math.round(cursorX + width / 2),
      width,
    });
    cursorX += width + COL_GAP;
  }

  let cursorY = PAD + HEADER_H + 28;
  const steps: MermaidSequenceStep[] = rawSteps.map((step) => {
    const y = cursorY;
    cursorY += step.kind === "message" && step.from === step.to ? 52 : STEP_H;
    return { ...step, y };
  });

  const lifelineBottom = Math.max(PAD + HEADER_H + 54, cursorY + 8);
  return {
    kind: "sequence",
    width: Math.max(240, Math.round(cursorX - COL_GAP + PAD)),
    height: Math.round(lifelineBottom + PAD),
    headerHeight: HEADER_H,
    lifelineBottom,
    participants,
    steps,
  };
}

function parseStateDiagram(lines: string[]): MermaidFlowLayout | null {
  if (!/^stateDiagram(?:-v2)?\b/i.test(lines[0])) return null;

  let direction: MermaidDirection = "TD";
  const nodes = new Map<string, RawNode>();
  const edges: MermaidFlowEdge[] = [];

  const ensureState = (
    rawId: string,
    role: "from" | "to" | "decl",
    label?: string,
  ): string | null => {
    const trimmed = rawId.trim();
    if (!trimmed) return null;
    if (trimmed === "[*]") {
      const id = role === "to" ? "__end__" : "__start__";
      if (!nodes.has(id) && nodes.size < MAX_MERMAID_NODES) {
        nodes.set(id, {
          id,
          label: "",
          shape: role === "to" ? "end" : "start",
        });
      }
      return nodes.has(id) ? id : null;
    }
    const existing = nodes.get(trimmed);
    if (existing) {
      if (label) existing.label = cleanLabel(label);
      return trimmed;
    }
    if (nodes.size >= MAX_MERMAID_NODES) return null;
    nodes.set(trimmed, {
      id: trimmed,
      label: cleanLabel(label || trimmed),
      shape: "rounded",
    });
    return trimmed;
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const dirMatch = /^direction\s+(TD|TB|LR|RL|BT)$/i.exec(line);
    if (dirMatch) {
      direction = dirMatch[1].toUpperCase() as MermaidDirection;
      continue;
    }
    // Fall back to source for composite states and multi-line state notes so nested
    // start states and note bodies are never misparsed as top-level states.
    if (/^(?:state\s+\S+\s*\{|note\s+(?:right|left)\s+of\b)/i.test(line)) {
      return null;
    }
    if (/^(?:\}|end$)/i.test(line)) continue;

    const aliasMatch = /^state\s+"([^"]+)"\s+as\s+([A-Za-z0-9_.-]+)$/i.exec(
      line,
    );
    if (aliasMatch) {
      ensureState(aliasMatch[2], "decl", aliasMatch[1]);
      continue;
    }

    const transMatch =
      /^(\[\*\]|[A-Za-z0-9_.-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/.exec(
        line,
      );
    if (transMatch) {
      const from = ensureState(transMatch[1], "from");
      const to = ensureState(transMatch[2], "to");
      if (from && to && edges.length < MAX_MERMAID_EDGES) {
        edges.push({
          from,
          to,
          ...(transMatch[3] ? { label: cleanLabel(transMatch[3]) } : {}),
          style: "solid",
          arrowStart: false,
          arrowEnd: true,
        });
      }
      continue;
    }

    const descMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line);
    if (descMatch) {
      ensureState(descMatch[1], "decl", `${descMatch[1]}\n${descMatch[2]}`);
    }
  }

  return layoutGraph("state", direction, nodes, edges, []);
}

function parseClassDiagram(lines: string[]): MermaidFlowLayout | null {
  if (!/^classDiagram\b/i.test(lines[0])) return null;

  let direction: MermaidDirection = "TD";
  const nodes = new Map<string, RawNode>();
  const edges: MermaidFlowEdge[] = [];
  let activeClass: string | null = null;

  const ensureClass = (name: string): RawNode | null => {
    const id = name.trim();
    if (!id) return null;
    const existing = nodes.get(id);
    if (existing) return existing;
    if (nodes.size >= MAX_MERMAID_NODES) return null;
    const created: RawNode = {
      id,
      label: id,
      shape: "rect",
      members: [],
    };
    nodes.set(id, created);
    return created;
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (activeClass) {
      if (line === "}") {
        activeClass = null;
        continue;
      }
      const cls = nodes.get(activeClass);
      if (cls && cls.members && cls.members.length < 10) {
        cls.members.push(cleanLabel(line));
      }
      continue;
    }

    const dirMatch = /^direction\s+(TD|TB|LR|RL|BT)$/i.exec(line);
    if (dirMatch) {
      direction = dirMatch[1].toUpperCase() as MermaidDirection;
      continue;
    }

    const blockStart = /^class\s+([A-Za-z0-9_.-]+)\s*\{$/.exec(line);
    if (blockStart) {
      if (ensureClass(blockStart[1])) activeClass = blockStart[1];
      continue;
    }

    const singleClass = /^class\s+([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (singleClass) {
      ensureClass(singleClass[1]);
      continue;
    }

    const relMatch =
      /^([A-Za-z0-9_.-]+)(?:\s+"[^"]*")?\s*(<\|\.\.|<\|--|--\|>|\*--|o--|--\*|--o|-->|<--|\.\.>|\.\.\|>|--|\.\.)\s*(?:"[^"]*"\s+)?([A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/.exec(
        line,
      );
    if (relMatch) {
      const left = ensureClass(relMatch[1]);
      const right = ensureClass(relMatch[3]);
      if (left && right && edges.length < MAX_MERMAID_EDGES) {
        const op = relMatch[2];
        const markerStart: MermaidMarkerKind = op.startsWith("<|")
          ? "triangle"
          : op.startsWith("<")
            ? "arrow"
            : op.startsWith("*")
              ? "diamond"
              : op.startsWith("o")
                ? "openDiamond"
                : "none";
        const markerEnd: MermaidMarkerKind = op.endsWith("|>")
          ? "triangle"
          : op.endsWith(">")
            ? "arrow"
            : op.endsWith("*")
              ? "diamond"
              : op.endsWith("o")
                ? "openDiamond"
                : "none";
        edges.push({
          from: left.id,
          to: right.id,
          ...(relMatch[4] ? { label: cleanLabel(relMatch[4]) } : {}),
          style: op.includes("..") ? "dashed" : "solid",
          arrowStart: markerStart !== "none",
          arrowEnd: markerEnd !== "none",
          markerStart,
          markerEnd,
        });
      }
      continue;
    }

    const memberLine = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line);
    if (memberLine) {
      const cls = ensureClass(memberLine[1]);
      if (cls && cls.members && cls.members.length < 10) {
        cls.members.push(cleanLabel(memberLine[2]));
      }
    }
  }

  return layoutGraph("class", direction, nodes, edges, []);
}

export function parseMermaidDiagram(source: string): MermaidLayout | null {
  const lines = preprocessLines(source);
  if (lines.length === 0) return null;
  const first = lines[0];
  if (/^(?:flowchart|graph)\b/i.test(first)) return parseFlowchart(lines);
  if (/^sequenceDiagram\b/i.test(first)) return parseSequence(lines);
  if (/^stateDiagram(?:-v2)?\b/i.test(first)) return parseStateDiagram(lines);
  if (/^classDiagram\b/i.test(first)) return parseClassDiagram(lines);
  return null;
}

export { measureTextLines };
