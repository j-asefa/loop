import { z } from "zod";
const timestamp = z
  .number()
  .finite()
  .min(-8640000000000000)
  .max(8640000000000000);
const point = z.tuple([timestamp, z.number().finite().nullable()]);
export const chartSchema = z
  .object({
    type: z.literal("timeseries"),
    title: z.string().max(200),
    timezone: z.literal("UTC"),
    series: z
      .array(
        z.object({
          name: z.string().max(200),
          unit: z.string().max(60),
          points: z.array(point).max(10000),
        }),
      )
      .min(1)
      .max(20),
    source: z.object({
      connectionId: z.string(),
      tool: z.string(),
      fetchedAt: timestamp,
      fixture: z.boolean().default(false),
    }),
    range: z.object({ from: timestamp, to: timestamp }),
  })
  .refine(
    (d) =>
      d.range.from <= d.range.to &&
      d.series.every((s) =>
        s.points.every((p) => p[0] >= d.range.from && p[0] <= d.range.to),
      ),
    "Samples must be inside the declared range",
  );
export type ChartData = z.infer<typeof chartSchema>;
// Callers pass a credential-redacted result. The complete response remains in
// its saved artifact; traces and run failures use this bounded explanation.
export function toolErrorMessage(result: any) {
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter(
      (item: any) => item.type === "text" && typeof item.text === "string",
    )
    .map((item: any) => item.text)
    .join("\n");
  return (
    text ||
    (result.structuredContent && JSON.stringify(result.structuredContent)) ||
    "The tool returned an error without details."
  ).slice(0, 2000);
}
export function normalizeResult(
  result: any,
  provenance: {
    connectionId: string;
    tool: string;
    fetchedAt: number;
    fixture?: boolean;
  },
) {
  let data = result.structuredContent;
  const text = (result.content || [])
    .filter((x: any) => x.type === "text")
    .map((x: any) => x.text)
    .join("\n");
  if (!data && text) {
    try {
      data = JSON.parse(text);
    } catch {}
  }
  const source = { ...provenance, fixture: !!provenance.fixture };
  if (result.isError === true)
    return {
      kind: "markdown",
      title: provenance.tool + " error",
      content:
        text ||
        (data
          ? "```json\n" + JSON.stringify(data, null, 2) + "\n```"
          : toolErrorMessage(result)),
    };
  const bitmap = result.content?.find(
    (c: any) =>
      c.type === "image" &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        c.mimeType,
      ) &&
      typeof c.data === "string" &&
      /^[a-zA-Z0-9+/=]+$/.test(c.data),
  );
  if (bitmap)
    return {
      kind: "image",
      title: provenance.tool + " image",
      content: JSON.stringify({
        mimeType: bitmap.mimeType,
        data: bitmap.data,
        source,
      }),
    };
  // Datadog v1 metric-query shape: preserve millisecond timestamps, gaps and source units.
  const candidate = data?.series ? data : data?.data?.series ? data.data : null;
  if (
    candidate &&
    Array.isArray(candidate.series) &&
    candidate.series.length &&
    candidate.series.every((s: any) => Array.isArray(s.pointlist))
  ) {
    try {
      const series = candidate.series.map((s: any) => ({
        name: String(s.display_name || s.metric || s.expression || "Series"),
        unit: String(
          s.unit?.[0]?.short_name ||
            s.unit?.[0]?.name ||
            s.unit ||
            "unit not supplied",
        ),
        points: z.array(point).min(1).max(10000).parse(s.pointlist),
      }));
      const times = series.flatMap((s: any) => s.points.map((p: any) => p[0]));
      const chart = chartSchema.parse({
        type: "timeseries",
        title: typeof data.query === "string" ? data.query : "Metric query",
        timezone: "UTC",
        series,
        source,
        range: {
          from: times.reduce(
            (a: number, b: number) => Math.min(a, b),
            Infinity,
          ),
          to: times.reduce((a: number, b: number) => Math.max(a, b), -Infinity),
        },
      });
      return {
        kind: "chart",
        title: chart.title,
        content: JSON.stringify(chart),
      };
    } catch {
      /* Preserve raw result as a readable fallback; never infer missing metric values. */
    }
  }
  if (data?.type === "timeseries") {
    const check = chartSchema.safeParse({ ...data, source });
    if (check.success)
      return {
        kind: "chart",
        title: check.data.title,
        content: JSON.stringify(check.data),
      };
  }
  if (
    data &&
    Array.isArray(data.columns) &&
    Array.isArray(data.rows) &&
    data.rows.length <= 1000 &&
    data.columns.length <= 50 &&
    data.columns.every((c: any) => typeof c === "string") &&
    data.rows.every(
      (r: any) => Array.isArray(r) && r.length === data.columns.length,
    )
  )
    return {
      kind: "table",
      title: "Tool result table",
      content: JSON.stringify({ columns: data.columns, rows: data.rows }),
    };
  return {
    kind: "markdown",
    title: provenance.tool + " result",
    content:
      text ||
      (data
        ? "```json\n" + JSON.stringify(data, null, 2) + "\n```"
        : "No textual result was returned."),
  };
}
