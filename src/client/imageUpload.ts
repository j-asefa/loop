// Photos are prepared on the device before upload: a phone photo is often
// several megabytes (and HEIC, which models cannot read), and a large body is
// what a slow tunnel drops. Large or HEIC images are scaled to fit within
// MAX_EDGE pixels and re-encoded as JPEG. Anything that cannot be decoded is
// sent unchanged.
export const MAX_EDGE = 2048;
// Smaller ordinary images are sent as they are.
export const REENCODE_ABOVE_BYTES = 1_500_000;
const PASS_THROUGH = /^image\/(gif|svg\+xml)$/;
const HEIF = /^image\/hei[cf](-sequence)?$/;

/** The size to draw an image so its longest side is at most `max`. */
export function fitWithin(width: number, height: number, max = MAX_EDGE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type Picked = { type: string; size: number; name: string };

/** HEIC or HEIF, by type or, when a picker reports no type, by name. */
function isHeif(file: Picked) {
  return HEIF.test(file.type.toLowerCase()) || /\.hei[cf]$/i.test(file.name);
}

/** Whether a file is worth re-encoding before upload. */
export function shouldPrepare(file: Picked) {
  const type = file.type.toLowerCase();
  if (isHeif(file)) return true;
  if (!type.startsWith("image/") || PASS_THROUGH.test(type)) return false;
  return file.size > REENCODE_ABOVE_BYTES;
}

/** Whether to send the re-encoded JPEG instead of the original: when it is
 * smaller, and always for HEIC, which models cannot read. */
export function sendConverted(original: Picked, convertedSize: number) {
  return convertedSize < original.size || isHeif(original);
}

export async function prepareImage(file: File): Promise<File> {
  if (!shouldPrepare(file) || typeof createImageBitmap !== "function")
    return file;
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob || !sendConverted(file, blob.size)) return file;
    const name = (file.name.replace(/\.[^./]+$/, "") || "photo") + ".jpg";
    return new File([blob], name, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}
