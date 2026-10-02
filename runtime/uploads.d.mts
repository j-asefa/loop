export const MAX_UPLOAD_BYTES: number;
export const UPLOAD_CHUNK_BYTES: number;
export function uploadName(name: unknown): boolean;
export function safeUploadName(name: unknown): string;
export function writeUploadChunk(
  root: string,
  request: {
    fileId: string;
    transferId: string;
    name: string;
    size: number;
    sha256: string;
    offset?: number;
    data?: string;
    check?: boolean;
  },
): { path: string; size: number; complete: boolean; nextOffset: number | null };
