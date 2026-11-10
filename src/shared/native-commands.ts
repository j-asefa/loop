import { z } from "zod";

export const NativeCommand = z.strictObject({
  name: z.string(),
  token: z.string(),
  kind: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  disabledReason: z.string().optional(),
  sourceInfo: z
    .object({
      source: z.string().optional(),
      scope: z.string().optional(),
      origin: z.string().optional(),
      baseDir: z.string().optional(),
      path: z.string().optional(),
    })
    .catchall(z.json())
    .optional(),
});
export type NativeCommand = z.infer<typeof NativeCommand>;
