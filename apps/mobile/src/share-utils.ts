import { draftWorkspaceBucket } from "./drafts-codec";

export const MAX_SHARE_URL_CHARS = 3_000;
export const MAX_SHARE_TITLE_CHARS = 300;
export const MAX_SHARE_TEXT_CHARS = 12_000;
export const MAX_SHARE_QUESTION_CHARS = 20_000;
export const MAX_SHARE_FILES = 8;

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
    sharedText ? sharedText.slice(0, 512) : "",
    ...files.map((f) => `${f.name}:${f.mimeType}:${f.size ?? 0}:${f.uri}`),
  ].join("|");
  const fingerprint = draftWorkspaceBucket(fingerprintSeed);

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
 * Returns `null` if the question is empty or idempotency key is invalid.
 */
export function buildShareSendPayload(input: {
  question: string;
  share: NormalizedIncomingShare;
  folderId?: string | null;
  agentId?: string | null;
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

  return body;
}

/**
 * Builds the combined prompt text when a share includes file attachments
 * (which are uploaded via `/api/uploads` and submitted via `/api/runs`).
 */
export function buildFileShareRunInput(
  question: string,
  share: NormalizedIncomingShare,
): string {
  const parts: string[] = [question.trim()];
  if (share.sourceUrl && isSafeHttpUrl(share.sourceUrl)) {
    parts.push(`Shared link: ${share.sourceUrl}`);
  }
  if (share.sharedText) {
    parts.push(`Shared text:\n${share.sharedText}`);
  }
  return parts.filter(Boolean).join("\n\n").slice(0, MAX_SHARE_QUESTION_CHARS);
}
