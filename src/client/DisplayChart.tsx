import { useId } from "react";
import type { DisplayChart as ChartData } from "../shared/display-spec";

// The Chart component of a display (a fenced `spec` block). Hand-written SVG;
// unrelated to the time-series `chart` artifact in Chart.tsx. The numbers are
// whatever the agent wrote, so no source line is shown. Every value is also in
// a table below the chart, so nothing depends on colour or on the drawing.

const W = 360;
const H = 220;
const PAD = { top: 12, right: 10, bottom: 34, left: 48 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

// Four colours from the theme, then each repeats with a second cue: a hatch
// for filled marks and a dash for lines (see legend swatches).
const COLOURS = [
  "var(--blue)",
  "var(--orange)",
  "var(--green)",
  "var(--brass-text)",
];
const DASHES = [undefined, "6 3", "2 3"];
const cue = (index: number) => ({
  colour: COLOURS[index % COLOURS.length],
  // 0: solid, 1: hatched or dashed, 2: dotted or cross-hatched.
  style: Math.floor(index / COLOURS.length) % DASHES.length,
});

export function DisplayChart({
  title,
  chart,
  compact,
}: {
  title: string;
  chart: ChartData;
  compact: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const kind =
    chart.type === "pie"
      ? `Pie chart, ${chart.segments.length} ${plural(chart.segments.length, "segment")}`
      : `${chart.type[0].toUpperCase()}${chart.type.slice(1)} chart, ${chart.series.length} ${plural(chart.series.length, "series", "series")}, ${chart.categories.length} ${plural(chart.categories.length, "category", "categories")}`;
  return (
    <figure className="display-chart">
      <figcaption className="display-chart-title">{title}</figcaption>
      {chart.type !== "pie" && chart.yLabel && (
        <p className="display-chart-axis">{chart.yLabel}</p>
      )}
      <svg
        className="display-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}. ${kind}. The numbers are in the table below.`}
      >
        <Patterns id={id} />
        {chart.type === "pie" ? (
          <Pie chart={chart} id={id} />
        ) : (
          <Series chart={chart} id={id} />
        )}
      </svg>
      {chart.type !== "pie" && chart.xLabel && (
        <p className="display-chart-axis display-chart-x">{chart.xLabel}</p>
      )}
      <Legend chart={chart} id={id} />
      {!compact && (
        <details className="display-chart-numbers">
          <summary>Show the numbers</summary>
          <Numbers chart={chart} />
        </details>
      )}
    </figure>
  );
}

const plural = (count: number, one: string, many = one + "s") =>
  count === 1 ? one : many;

// Hatch patterns for each colour, one set per chart so ids stay unique.
function Patterns({ id }: { id: string }) {
  return (
    <defs>
      {COLOURS.map((colour, c) =>
        [1, 2].map((style) => (
          <pattern
            key={`${c}-${style}`}
            id={`${id}-p${c}-${style}`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform={style === 1 ? "rotate(45)" : undefined}
          >
            <rect width="6" height="6" fill={colour} fillOpacity="0.25" />
            {style === 1 ? (
              <rect width="3" height="6" fill={colour} />
            ) : (
              <circle cx="3" cy="3" r="1.6" fill={colour} />
            )}
          </pattern>
        )),
      )}
    </defs>
  );
}

const fillFor = (id: string, index: number) => {
  const { colour, style } = cue(index);
  return style === 0
    ? colour
    : `url(#${id}-p${index % COLOURS.length}-${style})`;
};

function Legend({ chart, id }: { chart: ChartData; id: string }) {
  const entries =
    chart.type === "pie"
      ? shares(chart.segments.map((s) => s.value)).map(
          (share, i) => `${chart.segments[i].label} ${percent(share)}`,
        )
      : chart.series.length > 1
        ? chart.series.map((s) => s.name)
        : [];
  if (!entries.length) return null;
  const line = chart.type === "line";
  return (
    <ul className="display-chart-legend">
      {entries.map((label, i) => (
        <li key={i}>
          <svg viewBox="0 0 16 10" aria-hidden="true">
            {line ? (
              <line
                x1="0"
                y1="5"
                x2="16"
                y2="5"
                stroke={cue(i).colour}
                strokeWidth="2.5"
                strokeDasharray={DASHES[cue(i).style]}
              />
            ) : (
              <rect width="16" height="10" rx="2" fill={fillFor(id, i)} />
            )}
          </svg>
          {label}
        </li>
      ))}
    </ul>
  );
}

// ---- pie ------------------------------------------------------------------

// Shares of a total, safe when the sum would overflow.
function shares(values: number[]) {
  const top = Math.max(...values);
  const scaled = values.map((v) => v / top);
  const total = scaled.reduce((sum, v) => sum + v, 0);
  return scaled.map((v) => v / total);
}

const percent = (share: number) =>
  new Intl.NumberFormat("en", {
    style: "percent",
    maximumFractionDigits: share < 0.1 ? 1 : 0,
  }).format(share);

function Pie({
  chart,
  id,
}: {
  chart: Extract<ChartData, { type: "pie" }>;
  id: string;
}) {
  const cx = W / 2,
    cy = H / 2,
    r = H / 2 - 12;
  const parts = shares(chart.segments.map((s) => s.value));
  // A segment that is the whole pie (one segment, or the others too small to
  // draw) is a circle; an arc from a point back to itself draws nothing.
  const whole = parts.findIndex((share) => share > 0.99999);
  if (whole >= 0)
    return (
      <g stroke="var(--surface)" strokeWidth="1.5">
        <circle cx={cx} cy={cy} r={r} fill={fillFor(id, whole)} />
      </g>
    );
  let start = 0;
  return (
    <g stroke="var(--surface)" strokeWidth="1.5">
      {parts.map((share, i) => {
        const end = start + share;
        const point = (turn: number) => {
          const angle = turn * 2 * Math.PI - Math.PI / 2;
          return `${num(cx + r * Math.cos(angle))},${num(cy + r * Math.sin(angle))}`;
        };
        const d = `M${cx},${cy}L${point(start)}A${r},${r} 0 ${share > 0.5 ? 1 : 0} 1 ${point(end)}Z`;
        start = end;
        return <path key={i} d={d} fill={fillFor(id, i)} />;
      })}
    </g>
  );
}

// ---- bar, line and area ---------------------------------------------------

// Coordinates are rounded so no attribute carries a long float.
const num = (value: number) => Math.round(value * 100) / 100;

type Scale = {
  y: (value: number) => number;
  ticks: number[];
  lo: number;
  hi: number;
};

// A value axis over the data. Bar and area include zero. Equal or all-zero
// data still gets a span, and every step is computed on halves so spans
// between huge values never overflow.
export function valueScale(values: number[], fromZero: boolean): Scale {
  let lo = Math.min(...values, ...(fromZero ? [0] : []));
  let hi = Math.max(...values, ...(fromZero ? [0] : []));
  if (!values.length) [lo, hi] = [0, 1];
  if (!(hi / 2 - lo / 2 > 0)) {
    const pad = Math.abs(lo) / 2 || 0.5;
    [lo, hi] = fromZero && lo === 0 ? [0, 1] : [lo - pad, hi + pad];
    if (!(hi / 2 - lo / 2 > 0)) [lo, hi] = [lo - 0.5, lo + 0.5];
  }
  const ticks = niceTicks(lo, hi);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  const half = hi / 2 - lo / 2;
  return {
    y: (value) => PAD.top + PLOT_H - ((value / 2 - lo / 2) / half) * PLOT_H,
    ticks,
    lo,
    hi,
  };
}

function niceTicks(min: number, max: number): number[] {
  const span = max / 2 - min / 2;
  const rough = span / 2; // aim for about four steps over the full span
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? power * 10;
  if (!Number.isFinite(step) || step <= 0) return [min, max];
  const first = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let i = 0; ticks.length < 8; i++) {
    const tick = first + i * step;
    if (!Number.isFinite(tick)) break;
    if (ticks.length && tick === ticks[ticks.length - 1]) return [min, max];
    ticks.push(tick);
    if (tick >= max) break;
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

// Tick labels with as few significant digits as keep them distinct.
export function tickLabels(ticks: number[]): string[] {
  for (let digits = 3; digits <= 21; digits++) {
    const format = new Intl.NumberFormat("en", {
      notation: "compact",
      maximumSignificantDigits: digits,
    });
    const labels = ticks.map((tick) => format.format(tick));
    if (new Set(labels).size === labels.length) return labels;
  }
  return ticks.map((tick) => String(tick));
}

function Series({
  chart,
  id,
}: {
  chart: Exclude<ChartData, { type: "pie" }>;
  id: string;
}) {
  const n = chart.categories.length;
  const series = chart.series.map((s) => s.values.slice(0, n));
  const fromZero = chart.type !== "line";
  const scale = valueScale(series.flat(), fromZero);
  const labels = tickLabels(scale.ticks);
  const band = PLOT_W / n;
  const centre = (i: number) => PAD.left + band * (i + 0.5);
  const zero = scale.y(Math.min(Math.max(0, scale.lo), scale.hi));
  // Thin category labels so they never overlap; each is cut to 8 characters
  // and every category is in the table of numbers.
  const longest = Math.min(
    8,
    Math.max(...chart.categories.map((label) => label.length)),
  );
  const fits = Math.max(1, Math.floor(PLOT_W / (longest * 6.2 + 8)));
  const every = Math.ceil(n / fits);
  return (
    <>
      <g className="display-chart-grid">
        {scale.ticks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={num(scale.y(tick))}
              y2={num(scale.y(tick))}
            />
            <text x={PAD.left - 6} y={num(scale.y(tick) + 4)} textAnchor="end">
              {labels[i]}
            </text>
          </g>
        ))}
      </g>
      {chart.type === "bar" &&
        series.map((values, s) => {
          const width = (band * 0.8) / series.length;
          return (
            <g key={s} fill={fillFor(id, s)}>
              {values.map((value, i) => {
                const x = centre(i) - band * 0.4 + width * s;
                const y = scale.y(value);
                return (
                  <rect
                    key={i}
                    x={num(x)}
                    y={num(Math.min(y, zero))}
                    width={num(Math.max(width - (width > 3 ? 1 : 0), 0.5))}
                    height={num(Math.max(Math.abs(zero - y), 0.5))}
                  />
                );
              })}
            </g>
          );
        })}
      {chart.type !== "bar" &&
        series.map((values, s) => {
          if (!values.length) return null;
          const points = values.map(
            (value, i) => `${num(centre(i))},${num(scale.y(value))}`,
          );
          const { colour, style } = cue(s);
          return (
            <g key={s}>
              {chart.type === "area" && (
                <path
                  d={`M${num(centre(0))},${num(zero)}L${points.join("L")}L${num(centre(values.length - 1))},${num(zero)}Z`}
                  fill={fillFor(id, s)}
                  fillOpacity={style === 0 ? 0.22 : 0.6}
                />
              )}
              <path
                d={`M${points.join("L")}`}
                fill="none"
                stroke={colour}
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeDasharray={DASHES[style]}
              />
              {values.length <= 40 &&
                values.map((value, i) => (
                  <circle
                    key={i}
                    cx={num(centre(i))}
                    cy={num(scale.y(value))}
                    r="2.5"
                    fill={colour}
                  />
                ))}
            </g>
          );
        })}
      <line
        className="display-chart-baseline"
        x1={PAD.left}
        x2={W - PAD.right}
        y1={num(zero)}
        y2={num(zero)}
      />
      <g className="display-chart-categories">
        {chart.categories.map((label, i) =>
          i % every === 0 ? (
            <text
              key={i}
              x={num(centre(i))}
              y={H - PAD.bottom + 16}
              textAnchor="middle"
            >
              {label.length > 8 ? label.slice(0, 7) + "…" : label}
            </text>
          ) : null,
        )}
      </g>
    </>
  );
}

// ---- numbers --------------------------------------------------------------

function Numbers({ chart }: { chart: ChartData }) {
  if (chart.type === "pie") {
    const parts = shares(chart.segments.map((s) => s.value));
    return (
      <div
        className="table-scroll"
        role="region"
        aria-label="Chart numbers"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Segment</th>
              <th scope="col" className="align-right">
                Value
              </th>
              <th scope="col" className="align-right">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {chart.segments.map((segment, i) => (
              <tr key={i}>
                <th scope="row">{segment.label}</th>
                <td className="align-right">{String(segment.value)}</td>
                <td className="align-right">{percent(parts[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div
      className="table-scroll"
      role="region"
      aria-label="Chart numbers"
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            <th scope="col">{chart.xLabel || "Category"}</th>
            {chart.series.map((s, i) => (
              <th key={i} scope="col" className="align-right">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.categories.map((category, i) => (
            <tr key={i}>
              <th scope="row">{category}</th>
              {chart.series.map((s, j) => (
                <td key={j} className="align-right">
                  {i < s.values.length ? String(s.values[i]) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
