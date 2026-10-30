import "../deployment/environment.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { PreviewInfo } from "./shared/preview.js";

export const previewName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,47}$/,
    "Use a preview name of up to 48 lowercase letters, numbers or hyphens.",
  );
export const previewMode = z.enum(["design", "working"]);
export const previewManifest = z
  .object({
    schema: z.literal(1),
    previewId: z.string().uuid(),
    name: previewName,
    mode: previewMode,
    home: z.string().min(1),
    build: z
      .object({
        id: z.string().uuid(),
        branch: z.string(),
        commit: z.string().regex(/^[a-f0-9]{40,64}$/),
        dirty: z.boolean(),
        builtAt: z.string(),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export type PreviewManifest = z.infer<typeof previewManifest>;
export const PREVIEW_MARKER = "preview-owner.json";
export const preview = process.env.LOOP55_PREVIEW_MANIFEST
  ? previewManifest.parse(
      JSON.parse(readFileSync(process.env.LOOP55_PREVIEW_MANIFEST, "utf8")),
    )
  : undefined;
export const designPreview = preview?.mode === "design";
export const publicPreview: PreviewInfo | undefined = preview && {
  name: preview.name,
  mode: preview.mode,
  build: preview.build,
};

/** A preview database cannot be opened by an ordinary worker or another mode. */
export function assertPreviewDataDir(data: string) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(join(data, PREVIEW_MARKER), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!marker && !preview) return;
  if (
    !preview ||
    !marker ||
    marker.schema !== 1 ||
    marker.previewId !== preview.previewId ||
    marker.mode !== preview.mode ||
    resolve(data) !== join(resolve(preview.home), "workspace") ||
    resolve(process.env.LOOP55_HOME || "") !== resolve(preview.home)
  )
    throw new Error(
      "Preview state requires its own launcher and original mode. Use loop55 preview start NAME.",
    );
}
