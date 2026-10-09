import { Router } from "express";
import { z } from "zod";

const number = z.number().finite().min(-1e9).max(1e9);
const rect = z.array(number).refine((a) => a.length === 0 || a.length === 4);
const input = z
  .object({
    session: z.string().uuid(),
    samples: z
      .array(
        z
          .object({
            elapsed: number,
            viewport: z.array(number).length(9),
            dialog: rect,
            header: rect,
            input: rect,
            body: rect,
            flags: z.array(number).length(8),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

// Mounted behind the same owner/device/CSRF boundary as the rest of the API.
export const viewportDiagnostics = Router();
viewportDiagnostics.post("/ui/viewport-diagnostics", (req, res) => {
  const sample = input.parse(req.body);
  console.info("loop-viewport-diagnostics", JSON.stringify(sample));
  res.status(204).end();
});
