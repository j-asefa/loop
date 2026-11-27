export const MAX_MATH_EXPR_CHARS = 8_000;
const MAX_PARSE_DEPTH = 16;
const MAX_INLINE_MATH_SCAN = 1_024;

const MATRIX_DELIMITERS = new Map<string, [string, string]>([
  ["bmatrix", ["[", "]"]],
  ["pmatrix", ["(", ")"]],
  ["Bmatrix", ["{", "}"]],
  ["vmatrix", ["|", "|"]],
  ["Vmatrix", ["‖", "‖"]],
  ["cases", ["{", ""]],
  ["matrix", ["", ""]],
  ["aligned", ["", ""]],
  ["align", ["", ""]],
  ["align*", ["", ""]],
]);

const GREEK_AND_SYMBOLS: Record<string, string> = {
  // Lowercase Greek
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  // Uppercase Greek
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  // Operators & relations
  pm: "±",
  mp: "∓",
  times: "×",
  div: "÷",
  cdot: "·",
  ast: "∗",
  star: "⋆",
  circ: "∘",
  bullet: "•",
  oplus: "⊕",
  otimes: "⊗",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  propto: "∝",
  ll: "≪",
  gg: "≫",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  setminus: "∖",
  emptyset: "∅",
  varnothing: "∅",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  neg: "¬",
  lnot: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  implies: "⟹",
  iff: "⟺",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  mapsto: "↦",
  top: "⊤",
  bot: "⊥",
  perp: "⊥",
  parallel: "∥",
  angle: "∠",
  triangle: "△",
  degree: "°",
  prime: "′",
  ell: "ℓ",
  hbar: "ℏ",
  Re: "ℜ",
  Im: "ℑ",
  aleph: "ℵ",
  // Big operators & ellipsis
  sum: "∑",
  prod: "∏",
  coprod: "∐",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  bigcup: "⋃",
  bigcap: "⋂",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
  vdots: "⋮",
  ddots: "⋱",
  // Delimiters
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  mid: "|",
  // Spaces
  quad: "  ",
  qquad: "    ",
  enspace: " ",
};

const BLACKBOARD_BOLD: Record<string, string> = {
  C: "ℂ",
  E: "𝔼",
  H: "ℍ",
  N: "ℕ",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  Z: "ℤ",
};

const SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  d: "ᵈ",
  e: "ᵉ",
  f: "ᶠ",
  g: "ᵍ",
  h: "ʰ",
  j: "ʲ",
  k: "ᵏ",
  l: "ˡ",
  m: "ᵐ",
  o: "ᵒ",
  p: "ᵖ",
  r: "ʳ",
  s: "ˢ",
  t: "ᵗ",
  u: "ᵘ",
  v: "ᵛ",
  w: "ʷ",
  x: "ˣ",
  y: "ʸ",
  z: "ᶻ",
  T: "ᵀ",
};

const SUBSCRIPT_MAP: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

const TEXT_OPERATORS = new Set([
  "lim",
  "log",
  "ln",
  "lg",
  "exp",
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "max",
  "min",
  "sup",
  "inf",
  "arg",
  "det",
  "dim",
  "ker",
  "deg",
  "gcd",
  "lcm",
  "mod",
  "Pr",
]);

function toMappedScript(
  text: string,
  table: Record<string, string>,
  fallbackPrefix: "^" | "_",
): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let mapped = "";
  for (const ch of trimmed) {
    if (ch === " ") {
      mapped += " ";
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(table, ch)) {
      return trimmed.length === 1
        ? `${fallbackPrefix}${trimmed}`
        : `${fallbackPrefix}(${trimmed})`;
    }
    mapped += table[ch];
  }
  return mapped;
}

function readGroupOrAtom(
  src: string,
  pos: number,
): { content: string; next: number } {
  let i = pos;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i += 1;
  if (i >= src.length) return { content: "", next: i };
  if (src[i] === "{") {
    let depth = 1;
    let j = i + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "\\" && j + 1 < src.length) {
        j += 2;
        continue;
      }
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    return {
      content: src.slice(i + 1, depth === 0 ? j - 1 : j),
      next: j,
    };
  }
  if (src[i] === "\\") {
    let j = i + 1;
    if (j < src.length && /[A-Za-z]/.test(src[j])) {
      while (j < src.length && /[A-Za-z]/.test(src[j])) j += 1;
    } else if (j < src.length) {
      j += 1;
    }
    return { content: src.slice(i, j), next: j };
  }
  return { content: src[i], next: i + 1 };
}

function readOptionalBracket(
  src: string,
  pos: number,
): { content: string; next: number } | null {
  let i = pos;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i += 1;
  if (src[i] !== "[") return null;
  let depth = 1;
  let j = i + 1;
  while (j < src.length && depth > 0) {
    if (src[j] === "[") depth += 1;
    else if (src[j] === "]") depth -= 1;
    j += 1;
  }
  if (depth !== 0) return null;
  return { content: src.slice(i + 1, j - 1), next: j };
}

export type MathDisplaySegment =
  | { kind: "text"; text: string }
  | { kind: "fraction"; num: string; den: string }
  | { kind: "matrix"; left: string; right: string; rows: string[][] };

function formatMatrixEnv(
  env: string,
  body: string,
  depth: number,
): { left: string; right: string; rows: string[][] } {
  const [left, right] = MATRIX_DELIMITERS.get(env) ?? ["", ""];
  const rows = body
    .split(/\\\\/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((row) =>
      row.split("&").map((cell) => formatLatexInline(cell.trim(), depth + 1)),
    );
  return { left, right, rows };
}

/**
 * Formats a LaTeX math expression into clean, readable Unicode typography for
 * inline React Native `<Text>` rendering.
 */
export function formatLatexInline(rawExpr: string, depth = 0): string {
  if (!rawExpr || depth > MAX_PARSE_DEPTH) return rawExpr;
  const src =
    rawExpr.length > MAX_MATH_EXPR_CHARS
      ? rawExpr.slice(0, MAX_MATH_EXPR_CHARS)
      : rawExpr;

  let out = "";
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    // Environment blocks \begin{...}...\end{...}
    if (src.startsWith("\\begin{", i)) {
      const endName = src.indexOf("}", i + 7);
      if (endName !== -1) {
        const env = src.slice(i + 7, endName).trim();
        const closeTag = `\\end{${env}}`;
        const closeIdx = src.indexOf(closeTag, endName + 1);
        if (closeIdx !== -1) {
          const body = src.slice(endName + 1, closeIdx);
          const mat = formatMatrixEnv(env, body, depth);
          const rowStrings = mat.rows.map((r) => r.join(", "));
          out += `${mat.left}${rowStrings.join("; ")}${mat.right}`;
          i = closeIdx + closeTag.length;
          continue;
        }
      }
    }

    if (ch === "\\") {
      const nextCh = src[i + 1];
      if (!nextCh) {
        i += 1;
        continue;
      }
      // Escaped single-char commands
      if (
        nextCh === "{" ||
        nextCh === "}" ||
        nextCh === "%" ||
        nextCh === "$" ||
        nextCh === "_"
      ) {
        out += nextCh;
        i += 2;
        continue;
      }
      if (
        nextCh === "," ||
        nextCh === ";" ||
        nextCh === ":" ||
        nextCh === " "
      ) {
        out += " ";
        i += 2;
        continue;
      }
      if (nextCh === "!") {
        i += 2;
        continue;
      }
      if (nextCh === "\\") {
        out += "\n";
        i += 2;
        continue;
      }

      // Named control sequence \cmd
      let j = i + 1;
      while (j < src.length && /[A-Za-z]/.test(src[j])) j += 1;
      const cmd = src.slice(i + 1, j);
      i = j;

      if (
        cmd === "left" ||
        cmd === "right" ||
        cmd === "big" ||
        cmd === "Big" ||
        cmd === "bigg" ||
        cmd === "Bigg"
      ) {
        while (i < src.length && src[i] === " ") i += 1;
        if (src[i] === ".") {
          i += 1;
        }
        continue;
      }

      if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") {
        const num = readGroupOrAtom(src, i);
        const den = readGroupOrAtom(src, num.next);
        i = den.next;
        const nStr = formatLatexInline(num.content, depth + 1).trim();
        const dStr = formatLatexInline(den.content, depth + 1).trim();
        const wrapN = /[\s+\-/]/.test(nStr) ? `(${nStr})` : nStr;
        const wrapD = /[\s+\-/]/.test(dStr) ? `(${dStr})` : dStr;
        out += `${wrapN}/${wrapD}`;
        continue;
      }

      if (cmd === "binom" || cmd === "dbinom") {
        const top = readGroupOrAtom(src, i);
        const bot = readGroupOrAtom(src, top.next);
        i = bot.next;
        out += `C(${formatLatexInline(top.content, depth + 1).trim()}, ${formatLatexInline(bot.content, depth + 1).trim()})`;
        continue;
      }

      if (cmd === "sqrt") {
        const opt = readOptionalBracket(src, i);
        const body = readGroupOrAtom(src, opt ? opt.next : i);
        i = body.next;
        const formattedBody = formatLatexInline(body.content, depth + 1).trim();
        const prefix = opt
          ? `${toMappedScript(formatLatexInline(opt.content, depth + 1), SUPERSCRIPT_MAP, "^")}√`
          : "√";
        out +=
          formattedBody.length <= 2
            ? `${prefix}${formattedBody}`
            : `${prefix}(${formattedBody})`;
        continue;
      }

      if (
        cmd === "text" ||
        cmd === "textrm" ||
        cmd === "mathrm" ||
        cmd === "mathbf" ||
        cmd === "mathit" ||
        cmd === "mathsf" ||
        cmd === "mathtt" ||
        cmd === "mathcal" ||
        cmd === "operatorname"
      ) {
        const grp = readGroupOrAtom(src, i);
        i = grp.next;
        out +=
          cmd === "text" || cmd === "textrm"
            ? grp.content
            : formatLatexInline(grp.content, depth + 1);
        continue;
      }

      if (cmd === "mathbb") {
        const grp = readGroupOrAtom(src, i);
        i = grp.next;
        out += grp.content
          .split("")
          .map((c) =>
            Object.prototype.hasOwnProperty.call(BLACKBOARD_BOLD, c)
              ? BLACKBOARD_BOLD[c]
              : c,
          )
          .join("");
        continue;
      }

      if (
        cmd === "hat" ||
        cmd === "bar" ||
        cmd === "overline" ||
        cmd === "tilde" ||
        cmd === "vec" ||
        cmd === "dot"
      ) {
        const grp = readGroupOrAtom(src, i);
        i = grp.next;
        const inner = formatLatexInline(grp.content, depth + 1).trim();
        const combining =
          cmd === "hat"
            ? "\u0302"
            : cmd === "bar" || cmd === "overline"
              ? "\u0304"
              : cmd === "tilde"
                ? "\u0303"
                : cmd === "vec"
                  ? "\u20d7"
                  : "\u0307";
        out += inner.length === 1 ? `${inner}${combining}` : inner;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(GREEK_AND_SYMBOLS, cmd)) {
        out += GREEK_AND_SYMBOLS[cmd];
        continue;
      }

      if (TEXT_OPERATORS.has(cmd)) {
        out += cmd;
        continue;
      }

      // Unknown command: preserve readable name without leading backslash
      out += cmd;
      continue;
    }

    if (ch === "^" || ch === "_") {
      const grp = readGroupOrAtom(src, i + 1);
      i = grp.next;
      const inner = formatLatexInline(grp.content, depth + 1);
      out += toMappedScript(
        inner,
        ch === "^" ? SUPERSCRIPT_MAP : SUBSCRIPT_MAP,
        ch,
      );
      continue;
    }

    if (ch === "{" || ch === "}") {
      i += 1;
      continue;
    }

    if (ch === "~") {
      out += " ";
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Parses a display-math expression into rows of structured segments so top-level
 * fractions and matrices render natively as stacked layouts in React Native.
 */
export function parseLatexDisplayRows(rawExpr: string): MathDisplaySegment[][] {
  const src =
    rawExpr.length > MAX_MATH_EXPR_CHARS
      ? rawExpr.slice(0, MAX_MATH_EXPR_CHARS).trim()
      : rawExpr.trim();
  if (!src) return [];

  // Split top-level lines (not inside \begin{...}...\end{...}) on \\
  const rows: MathDisplaySegment[][] = [];
  let currentRow: MathDisplaySegment[] = [];
  let textBuf = "";
  let braceDepth = 0;
  let i = 0;

  const flushText = () => {
    const formatted = formatLatexInline(textBuf);
    if (formatted) {
      currentRow.push({ kind: "text", text: formatted });
    }
    textBuf = "";
  };

  while (i < src.length) {
    if (braceDepth === 0 && src.startsWith("\\begin{", i)) {
      const endName = src.indexOf("}", i + 7);
      if (endName !== -1) {
        const env = src.slice(i + 7, endName).trim();
        const closeTag = `\\end{${env}}`;
        const closeIdx = src.indexOf(closeTag, endName + 1);
        if (closeIdx !== -1) {
          flushText();
          const mat = formatMatrixEnv(env, src.slice(endName + 1, closeIdx), 0);
          currentRow.push({ kind: "matrix", ...mat });
          i = closeIdx + closeTag.length;
          continue;
        }
      }
    }

    if (
      braceDepth === 0 &&
      (src.startsWith("\\frac", i) ||
        src.startsWith("\\dfrac", i) ||
        src.startsWith("\\tfrac", i))
    ) {
      const cmdLen = src.startsWith("\\frac", i) ? 5 : 6;
      const nextAfter = src[i + cmdLen];
      if (!nextAfter || !/[A-Za-z]/.test(nextAfter)) {
        const num = readGroupOrAtom(src, i + cmdLen);
        const den = readGroupOrAtom(src, num.next);
        if (num.content.trim() || den.content.trim()) {
          flushText();
          currentRow.push({
            kind: "fraction",
            num: formatLatexInline(num.content),
            den: formatLatexInline(den.content),
          });
          i = den.next;
          continue;
        }
      }
    }

    if (braceDepth === 0 && src[i] === "\\" && src[i + 1] === "\\") {
      flushText();
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
      i += 2;
      continue;
    }

    if (src[i] === "\\" && i + 1 < src.length) {
      textBuf += src.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (src[i] === "{") braceDepth += 1;
    else if (src[i] === "}") braceDepth = Math.max(0, braceDepth - 1);

    textBuf += src[i];
    i += 1;
  }

  flushText();
  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
}

/**
 * Finds inline LaTeX math (`$...$` or `\(...\)`) starting at `start`.
 * Enforces strict currency guards, skips backtick code spans, and bounds scan
 * length so unclosed delimiters on long lines stay O(1).
 */
export function findInlineMathAt(
  text: string,
  start: number,
): { raw: string; end: number } | null {
  const limit = Math.min(text.length, start + MAX_INLINE_MATH_SCAN);

  // \( ... \) form
  if (text.startsWith("\\(", start)) {
    let i = start + 2;
    while (i < limit - 1) {
      if (text[i] === "\n" || text[i] === "`") return null;
      if (text[i] === "\\" && text[i + 1] === ")") {
        const inner = text.slice(start + 2, i).trim();
        if (!inner) return null;
        return { raw: inner, end: i + 2 };
      }
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      i += 1;
    }
    return null;
  }

  // $ ... $ form (must not be $$, preceded by \ or identifier char, or followed by whitespace)
  if (text[start] !== "$") return null;
  if (
    text[start + 1] === "$" ||
    !text[start + 1] ||
    /\s/.test(text[start + 1])
  ) {
    return null;
  }
  if (
    start > 0 &&
    (text[start - 1] === "\\" || /[A-Za-z0-9_]/.test(text[start - 1]))
  ) {
    return null;
  }

  let i = start + 1;
  while (i < limit) {
    const ch = text[i];
    if (ch === "\n" || ch === "`") return null;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "$") {
      // Closing $ must not be preceded by whitespace, must not be $$, and must
      // not be immediately followed by an identifier/digit/template brace
      // (blocks "$5 and $10", "$PATH:$HOME", "$ref/$id", "${A}/${B}").
      const prev = text[i - 1];
      const next = text[i + 1];
      if (
        !prev ||
        /\s/.test(prev) ||
        next === "$" ||
        (next !== undefined && /[A-Za-z0-9_{]/.test(next))
      ) {
        return null;
      }
      const inner = text.slice(start + 1, i);
      if (!inner.trim()) return null;
      return { raw: inner, end: i + 1 };
    }
    i += 1;
  }
  return null;
}
