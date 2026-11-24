// What a published file is, in words a card can show under its name.

const KIB = 1024;

export function attachmentKind(mime: string, name = "") {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return "Image";
  if (type === "text/html") return "Web page";
  if (type === "application/pdf") return "PDF";
  if (type === "text/markdown" || /\.md$/i.test(name)) return "Markdown";
  if (type === "text/csv") return "Spreadsheet";
  if (type.startsWith("video/")) return "Video";
  if (type.startsWith("audio/")) return "Audio";
  if (type.startsWith("text/") || type === "application/json") return "Text";
  return "File";
}

export function attachmentSize(bytes: number) {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < KIB * KIB) return `${Math.round(bytes / KIB)} KB`;
  return `${(bytes / (KIB * KIB)).toFixed(1)} MB`;
}

/** Only raster images get a thumbnail; their bytes are already the preview. */
export function attachmentThumbnail(mime: string) {
  return /^image\/(png|jpe?g|gif|webp|avif)$/i.test(mime.split(";")[0].trim());
}
