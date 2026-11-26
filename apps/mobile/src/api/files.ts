export type PublishedFileItem = {
  id: string;
  title: string;
  name: string;
  mime: string;
  size: number;
  /** Canonical same-origin Loop path: /api/artifacts/<id>/file or /api/objects/<id> */
  path: string;
  artifactId?: string;
  isText?: boolean;
  conversationId?: string | null;
  agentName?: string | null;
  projectName?: string | null;
  createdAt?: number;
};

export type LoopFileTarget = {
  kind: "artifact" | "object";
  id: string;
  /** Canonical same-origin Loop download path (/api/artifacts/<id>/file or /api/objects/<id>) */
  path: string;
  sourceId?: string;
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  log: "text/plain",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  py: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  zip: "application/zip",
};

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function guessMimeFromName(name: string): string {
  const clean = name.split("?")[0]?.split("#")[0] ?? "";
  const ext = clean.includes(".") ? clean.split(".").pop()?.toLowerCase() : "";
  return (ext && EXT_TO_MIME[ext]) || "application/octet-stream";
}

export function normalizeMime(
  mime: string | null | undefined,
  name: string,
): string {
  const base = (mime || "").split(";")[0].trim().toLowerCase();
  if (!base || base === "application/octet-stream") {
    return guessMimeFromName(name);
  }
  return base;
}

export function isPreviewableImageMime(mime: string, name = ""): boolean {
  const normalized = normalizeMime(mime, name);
  return (
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/webp" ||
    normalized === "image/gif"
  );
}

export function isMarkdownFile(mime: string, name = ""): boolean {
  const normalized = normalizeMime(mime, name);
  return normalized === "text/markdown" || /\.(md|markdown)$/i.test(name);
}

export function isHtmlFile(mime: string, name = ""): boolean {
  const normalized = normalizeMime(mime, name);
  return normalized === "text/html" || /\.(html?|xhtml)$/i.test(name);
}

export function isPreviewableTextMime(mime: string, name = ""): boolean {
  const normalized = normalizeMime(mime, name);
  if (isHtmlFile(normalized, name)) return false;
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/yaml"
  );
}

export function formatFileBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseArtifactFileMetadata(
  rawMetadata: string | null | undefined,
  fallbackTitle: string,
): {
  name: string;
  mime: string;
  size: number;
  isText: boolean;
} {
  let parsed: Record<string, unknown> = {};
  if (rawMetadata) {
    try {
      const candidate = JSON.parse(rawMetadata);
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // Fallback to defaults
    }
  }
  const name =
    typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : fallbackTitle || "Published file";
  const rawMime = typeof parsed.mime === "string" ? parsed.mime : "";
  const mime = normalizeMime(rawMime, name);
  const size =
    typeof parsed.size === "number" &&
    Number.isFinite(parsed.size) &&
    parsed.size >= 0
      ? parsed.size
      : 0;
  const isText = parsed.text === true || isPreviewableTextMime(mime, name);
  return { name, mime, size, isText };
}

export function parseContentDispositionFilename(
  header: string | null | undefined,
): string | undefined {
  if (!header) return undefined;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      // Fall through to plain filename
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(header);
  return plainMatch?.[1]?.trim() || undefined;
}

export function sanitizeDownloadFilename(
  rawName: string | null | undefined,
  fallbackId = "file",
): string {
  const leaf = (rawName || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!leaf)
    return `loop-${fallbackId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "file"}`;
  return leaf.slice(0, 120);
}

/**
 * Resolves a Markdown link/image URL or Spec LinkButton URL to a canonical
 * same-origin Loop file path (`/api/artifacts/<id>/file` or `/api/objects/<id>`).
 * Returns null for external links or cross-origin URLs so session credentials
 * are never sent to another origin.
 */
export function resolveLoopFileTarget(
  rawHref: string | null | undefined,
  workspaceOrigin?: string | null,
): LoopFileTarget | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;

  const baseOrigin = workspaceOrigin || "https://loop.invalid";
  let parsed: URL;
  try {
    if (trimmed.startsWith("/")) {
      if (trimmed.startsWith("//")) return null;
      parsed = new URL(trimmed, baseOrigin);
    } else if (/^https?:\/\//i.test(trimmed)) {
      if (!workspaceOrigin) return null;
      parsed = new URL(trimmed);
      if (parsed.origin !== workspaceOrigin) return null;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  // 1. /api/[agent-sources/<src>/]artifacts/<id>/(file|download)
  const artifactMatch =
    /^\/api\/(?:agent-sources\/([^/]+)\/)?artifacts\/([^/]+)\/(?:file|download)$/.exec(
      parsed.pathname,
    );
  if (artifactMatch) {
    const sourceId = artifactMatch[1]
      ? decodeURIComponent(artifactMatch[1])
      : undefined;
    const id = decodeURIComponent(artifactMatch[2]);
    if (!SAFE_ID_RE.test(id)) return null;
    if (sourceId && !SAFE_ID_RE.test(sourceId)) return null;
    const prefix = sourceId
      ? `/api/agent-sources/${encodeURIComponent(sourceId)}`
      : "/api";
    return {
      kind: "artifact",
      id,
      sourceId,
      path: `${prefix}/artifacts/${encodeURIComponent(id)}/file`,
    };
  }

  // 2. /api/[agent-sources/<src>/]objects/<id>
  const objectMatch =
    /^\/api\/(?:agent-sources\/([^/]+)\/)?objects\/([^/]+)$/.exec(
      parsed.pathname,
    );
  if (objectMatch) {
    const sourceId = objectMatch[1]
      ? decodeURIComponent(objectMatch[1])
      : undefined;
    const id = decodeURIComponent(objectMatch[2]);
    if (!SAFE_ID_RE.test(id)) return null;
    if (sourceId && !SAFE_ID_RE.test(sourceId)) return null;
    const prefix = sourceId
      ? `/api/agent-sources/${encodeURIComponent(sourceId)}`
      : "/api";
    return {
      kind: "object",
      id,
      sourceId,
      path: `${prefix}/objects/${encodeURIComponent(id)}`,
    };
  }

  // 3. /?artifact=<id> (canonical workspaceLink returned by loop_publish_file)
  if (parsed.pathname === "/" || parsed.pathname === "") {
    const artifactId = parsed.searchParams.get("artifact");
    const sourceId = parsed.searchParams.get("source") || undefined;
    if (artifactId && SAFE_ID_RE.test(artifactId)) {
      if (sourceId && !SAFE_ID_RE.test(sourceId)) return null;
      const prefix = sourceId
        ? `/api/agent-sources/${encodeURIComponent(sourceId)}`
        : "/api";
      return {
        kind: "artifact",
        id: artifactId,
        sourceId,
        path: `${prefix}/artifacts/${encodeURIComponent(artifactId)}/file`,
      };
    }
  }

  return null;
}
