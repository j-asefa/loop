import type { Response } from "express";
import { isHtmlFile } from "../shared/file-preview.js";

// Serve a separate document so its policy does not inherit the app's CSP.
// Never grant allow-same-origin: agent-authored scripts must not access Loop's
// DOM, cookies or storage, even if the preview URL is opened outside the sheet.
export function sendHtmlPreview(
  res: Response,
  preview: unknown,
  file: { name: string; mime: string; bytes: Buffer },
) {
  if (preview !== "html" || !isHtmlFile(file.name, file.mime)) return false;
  const filename = encodeURIComponent(file.name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${filename}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  );
  res.send(file.bytes);
  return true;
}
