import { z } from "zod";
import { pullRequestCard } from "../../shared/github.js";
import { chartPoint, chartSchema } from "../../shared/chart.js";
import type { ArtifactKind } from "../../shared/artifact-kind.js";

// A normalised tool result: the artifact kind is a declared enum value so the
// stored row always draws with a known renderer (D1).
export type NormalizedResult = {
  kind: ArtifactKind;
  title: string;
  content: string;
};
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
    github?: boolean;
  },
): NormalizedResult {
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
  const { github, ...rest } = provenance;
  const source = { ...rest, fixture: !!provenance.fixture };
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
  // Pull requests from the official GitHub server render as PR cards; the
  // complete response stays in the artifact's toolResult metadata.
  const pulls = github
    ? pullRequestCard(provenance.tool, data, provenance.fetchedAt)
    : undefined;
  if (pulls)
    return {
      kind: "github_pr",
      title:
        pulls.pulls.length === 1
          ? `${pulls.pulls[0].owner}/${pulls.pulls[0].repo} #${pulls.pulls[0].number}`
          : `${pulls.total ?? pulls.pulls.length} pull requests`,
      content: JSON.stringify(pulls),
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
        points: z.array(chartPoint).min(1).max(10000).parse(s.pointlist),
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
