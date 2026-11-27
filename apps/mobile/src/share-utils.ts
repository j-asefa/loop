export const MAX_SHARE_URL_CHARS = 3_000;
export const MAX_SHARE_TITLE_CHARS = 300;
export const MAX_SHARE_TEXT_CHARS = 12_000;
export const MAX_SHARE_QUESTION_CHARS = 20_000;
export const MAX_SHARE_FILES = 8;

/** Case-sensitive 64-bit content fingerprint for incoming share deduplication. */
export function shareContentFingerprint(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < seed.length; i += 1) {
    const code = seed.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `sh_${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export type RawIncomingSharePayload = {
  value: string;
  shareType: "text" | "url" | "audio" | "image" | "video" | "file";
  mimeType?: string;
  contentUri?: string | null;
  contentMimeType?: string | null;
  originalName?: string | null;
  contentSize?: number | null;
};

export type NormalizedShareFile = {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
};

export type NormalizedIncomingShare = {
  sourceUrl?: string;
  sourceTitle?: string;
  sharedText?: string;
  files: NormalizedShareFile[];
  fingerprint: string;
};

export type ShareSendRequestBody = {
  question: string;
  source?: {
    url: string;
    title: string;
    excerpt: string;
  };
  sharedText?: string;
  folderId?: string;
  newAgentId?: string;
  attachmentIds?: string[];
  idempotencyKey: string;
};

/**
 * Mirrors server `SharedSource` URL validation: HTTP/HTTPS only, no embedded
 * credentials, bounded length.
 */
export function isSafeHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_SHARE_URL_CHARS) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function safeFileNameFromUri(
  uri: string,
  fallbackMime: string,
  index: number,
): string {
  const cleanPath = uri.split("?")[0].split("#")[0];
  const lastSeg = cleanPath.slice(cleanPath.lastIndexOf("/") + 1);
  if (lastSeg) {
    try {
      const decoded = decodeURIComponent(lastSeg).replace(/[/\\]/g, "_").trim();
      if (decoded) return decoded.slice(0, 120);
    } catch {
      const cleaned = lastSeg.replace(/[/\\]/g, "_").trim();
      if (cleaned) return cleaned.slice(0, 120);
    }
  }
  const ext = fallbackMime.startsWith("image/")
    ? fallbackMime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg"
    : fallbackMime.startsWith("audio/")
      ? "m4a"
      : fallbackMime.startsWith("video/")
        ? "mp4"
        : fallbackMime === "application/pdf"
          ? "pdf"
          : "bin";
  return `shared-${index + 1}.${ext}`;
}

export function normalizeIncomingSharePayloads(
  payloads: RawIncomingSharePayload[],
): NormalizedIncomingShare | null {
  if (!Array.isArray(payloads) || payloads.length === 0) return null;

  let sourceUrl: string | undefined;
  let sourceTitle: string | undefined;
  const textParts: string[] = [];
  const files: NormalizedShareFile[] = [];

  for (const item of payloads) {
    if (!item || typeof item.value !== "string") continue;
    const rawValue = item.value.trim();

    if (item.shareType === "url") {
      if (!sourceUrl && isSafeHttpUrl(rawValue)) {
        sourceUrl = rawValue;
        try {
          sourceTitle = new URL(rawValue).hostname.slice(
            0,
            MAX_SHARE_TITLE_CHARS,
          );
        } catch {
          sourceTitle = "";
        }
      }
      continue;
    }

    if (item.shareType === "text") {
      if (!rawValue) continue;
      // Some Android/iOS apps share a bare URL with shareType === "text"
      if (!sourceUrl && !/\s/.test(rawValue) && isSafeHttpUrl(rawValue)) {
        sourceUrl = rawValue;
        try {
          sourceTitle = new URL(rawValue).hostname.slice(
            0,
            MAX_SHARE_TITLE_CHARS,
          );
        } catch {
          sourceTitle = "";
        }
      } else {
        textParts.push(rawValue);
      }
      continue;
    }

    // File / image / audio / video share
    if (files.length >= MAX_SHARE_FILES) continue;
    const uri = (item.contentUri || rawValue).trim();
    if (!uri) continue;
    const mimeType =
      (item.contentMimeType || item.mimeType || "").trim() ||
      (item.shareType === "image"
        ? "image/jpeg"
        : item.shareType === "audio"
          ? "audio/mp4"
          : item.shareType === "video"
            ? "video/mp4"
            : "application/octet-stream");
    const name =
      (item.originalName || "").replace(/[/\\]/g, "_").trim().slice(0, 120) ||
      safeFileNameFromUri(uri, mimeType, files.length);
    const size =
      typeof item.contentSize === "number" &&
      Number.isFinite(item.contentSize) &&
      item.contentSize > 0
        ? item.contentSize
        : undefined;
    files.push({
      uri,
      name,
      mimeType,
      ...(size !== undefined ? { size } : {}),
    });
  }

  const joinedText = textParts.join("\n\n").trim();
  const sharedText = joinedText
    ? joinedText.slice(0, MAX_SHARE_TEXT_CHARS)
    : undefined;

  if (!sourceUrl && !sharedText && files.length === 0) {
    return null;
  }

  const fingerprintSeed = [
    sourceUrl || "",
    sharedText || "",
    ...files.map((f) => `${f.name}:${f.mimeType}:${f.size ?? 0}:${f.uri}`),
  ].join("|");
  const fingerprint = shareContentFingerprint(fingerprintSeed);

  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(sharedText ? { sharedText } : {}),
    files,
    fingerprint,
  };
}

/**
 * Builds a request body matching server `ShareSendInput` (`POST /api/share/send`).
 * All incoming shares — links, text, and uploaded files — route through `/api/share/send`
 * so the server preserves untrusted-share handling (`shared: true`).
 */
export function buildShareSendPayload(input: {
  question: string;
  share: NormalizedIncomingShare;
  folderId?: string | null;
  agentId?: string | null;
  attachmentIds?: string[];
  idempotencyKey: string;
}): ShareSendRequestBody | null {
  const question = input.question.trim().slice(0, MAX_SHARE_QUESTION_CHARS);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!question || idempotencyKey.length < 10 || idempotencyKey.length > 150) {
    return null;
  }

  const body: ShareSendRequestBody = {
    question,
    idempotencyKey,
  };

  if (input.share.sourceUrl && isSafeHttpUrl(input.share.sourceUrl)) {
    body.source = {
      url: input.share.sourceUrl.trim(),
      title: (input.share.sourceTitle || "")
        .trim()
        .slice(0, MAX_SHARE_TITLE_CHARS),
      excerpt: (input.share.sharedText || "")
        .trim()
        .slice(0, MAX_SHARE_TEXT_CHARS),
    };
  } else if (input.share.sharedText) {
    body.sharedText = input.share.sharedText.slice(0, MAX_SHARE_TEXT_CHARS);
  }

  if (input.folderId && input.folderId.trim()) {
    body.folderId = input.folderId.trim();
  }
  if (input.agentId && input.agentId.trim()) {
    body.newAgentId = input.agentId.trim();
  }
  if (input.attachmentIds && input.attachmentIds.length > 0) {
    body.attachmentIds = input.attachmentIds.slice(0, MAX_SHARE_FILES);
  }

  return body;
}

/** Extracts a leading `@handle` mention if present so UI notices match server routing. */
export function extractLeadingShareHandle(question: string): string | null {
  const match = question.trim().match(/^@([^\s]+)(?:\s|$)/);
  if (!match) return null;
  const cleaned = match[1].toLowerCase().replace(/[,;:]$/, "");
  return cleaned || null;
}
