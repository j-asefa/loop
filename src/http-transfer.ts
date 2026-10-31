import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request, Response } from "express";
import compression from "compression";

const installed = new WeakSet<ServerResponse>();
const compress = compression({
  filter(req, res) {
    // Live events must arrive immediately. Downloads and byte ranges retain
    // their original representation, size and resumable transfer semantics.
    const type = String(res.getHeader("Content-Type") ?? "");
    if (
      /^text\/event-stream\b/i.test(type) ||
      req.headers.range ||
      res.statusCode === 206 ||
      res.hasHeader("Content-Range") ||
      res.hasHeader("Content-Disposition")
    )
      return false;
    return compression.filter(req, res);
  },
});

export function compressResponse(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) {
  // Paired requests pass through both the Node gateway and Express. Install
  // one compressor; the middleware itself uses only Node HTTP interfaces.
  if (installed.has(res)) return next();
  installed.add(res);
  compress(req as Request, res as Response, next);
}

export function assetCacheControl(publicPath: string) {
  // Vite changes these URLs when their contents change. Stable entrypoints
  // (HTML, service worker, manifest) must always discover the current build.
  if (/^\/assets\/[^/]+-[\w-]{8,}\.[^/]+$/.test(publicPath))
    return "public, max-age=31536000, immutable";
  // Avatar URLs are stable across releases, so retain the bytes but validate
  // before reuse. A deployment can replace the artwork at the same URL.
  if (/^\/avatars\/(?:robots\/)?[a-z]+\.webp$/.test(publicPath))
    return "public, max-age=0, must-revalidate";
  return "no-store";
}
