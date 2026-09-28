export const MAX_PUBLISHED_BYTES: number;
export const FILE_CHUNK_BYTES: number;
export function fileMime(name: string): string;
export function readPublishedChunk(
  directory: string,
  path: string,
  offset?: number,
  version?: string,
): {
  name: string;
  mime: string;
  size: number;
  version: string;
  offset: number;
  nextOffset: number | null;
  base64: string;
};
