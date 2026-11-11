import type { Response } from "express";
import { isHtmlFile } from "../shared/file-preview.js";

export const FILE_DOWNLOAD_POLICY = "default-src 'none'; sandbox";

export const FILE_PREVIEW_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";

// HTML previews are separate documents with an opaque origin: scripts must
// never access Loop's DOM, cookies or storage, even outside the preview sheet.
export function sendFile(
  res: Response,
  preview: unknown,
  file: { name: string; mime: string; bytes: Buffer },
  options: { downloadMime?: string; inlineImages?: boolean } = {},
) {
  const html = preview === "html" && isHtmlFile(file.name, file.mime);
  const inline =
    html ||
    (options.inlineImages &&
      preview === "1" &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        file.mime,
      ));
  const filename = encodeURIComponent(file.name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  res.setHeader(
    "Content-Type",
    html ? "text/html; charset=utf-8" : (options.downloadMime ?? file.mime),
  );
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  if (html) res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    html ? FILE_PREVIEW_POLICY : FILE_DOWNLOAD_POLICY,
  );
  res.send(file.bytes);
}
