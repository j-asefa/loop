import { McpConnectionId } from "./contract-ids.js";
import { z } from "zod";

// Time-series result charts: validated by the tool broker before saving and
// again by the browser before rendering.
const timestamp = z
  .number()
  .finite()
  .min(-8640000000000000)
  .max(8640000000000000);
export const chartPoint = z.tuple([timestamp, z.number().finite().nullable()]);
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
          points: z.array(chartPoint).max(10000),
        }),
      )
      .min(1)
      .max(20),
    source: z.object({
      connectionId: McpConnectionId,
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
