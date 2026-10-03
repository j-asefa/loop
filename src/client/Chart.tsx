import { parse } from "./api";
import { chartSchema } from "../server/mcp/results";
export function Chart({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  const checked = chartSchema.safeParse(parse<unknown>(content, null));
  const data = checked.success ? checked.data : null;
  if (!data?.series?.length)
    return <p>Chart data is unavailable. Download the source to inspect it.</p>;
  const W = 600,
    H = 180;
  return (
    <div className="native-chart">
      <p className="field-hint">
        {data.source.fixture ? "Fixture data · " : ""}
        {data.timezone} · {new Date(data.range.from).toISOString()} –{" "}
        {new Date(data.range.to).toISOString()}
      </p>
      {data.series.slice(0, compact ? 2 : 20).map((s, i) => {
        const values = s.points.filter((p) => p[1] !== null).map((p) => p[1]!),
          min = Math.min(...values),
          max = Math.max(...values),
          span = max - min || 1;
        let d = "",
          pen = false;
        for (const [t, v] of s.points) {
          if (v === null) {
            pen = false;
            continue;
          }
          const x =
              20 +
              ((t - data.range.from) /
                Math.max(1, data.range.to - data.range.from)) *
                (W - 40),
            y = H - 25 - ((v - min) / span) * (H - 45);
          d += (pen ? "L" : "M") + x.toFixed(2) + "," + y.toFixed(2) + " ";
          pen = true;
        }
        return (
          <div key={i}>
            <strong>
              {s.name} <small>({s.unit})</small>
            </strong>
            {values.length ? (
              <svg
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label={`${s.name}, ${s.unit}, ${values.length} measured points. Range ${min} to ${max}. Gaps represent missing data.`}
              >
                <path
                  d={`M20 10V${H - 25}H${W - 20}`}
                  stroke="currentColor"
                  opacity=".15"
                  fill="none"
                />
                <path
                  d={d}
                  stroke="var(--chart-color,#917920)"
                  strokeWidth="2.5"
                  fill="none"
                />
                {s.points.length <= 200 &&
                  s.points
                    .filter((p) => p[1] !== null)
                    .map(([t, v], index) => (
                      <circle
                        key={index}
                        cx={
                          20 +
                          ((t - data.range.from) /
                            Math.max(1, data.range.to - data.range.from)) *
                            (W - 40)
                        }
                        cy={H - 25 - ((v! - min) / span) * (H - 45)}
                        r="3"
                        fill="var(--chart-color,#917920)"
                      />
                    ))}
                <text x="24" y="18" fill="currentColor" fontSize="12">
                  {max.toPrecision(4)}
                </text>
                <text x="24" y={H - 7} fill="currentColor" fontSize="12">
                  {min.toPrecision(4)}
                </text>
              </svg>
            ) : (
              <p>No measured points in this range.</p>
            )}
            {!compact && (
              <details>
                <summary>Inspect {s.points.length} data points</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Time (UTC)</th>
                        <th>{s.unit}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.points.map(([t, v], j) => (
                        <tr key={j}>
                          <td>{new Date(t).toISOString()}</td>
                          <td>{v ?? "Missing"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        );
      })}
      {!compact && (
        <p className="field-hint">
          Source: {data.source.tool} · Captured{" "}
          {new Date(data.source.fetchedAt).toISOString()}. Values are preserved;
          missing samples stay missing.
        </p>
      )}
    </div>
  );
}
