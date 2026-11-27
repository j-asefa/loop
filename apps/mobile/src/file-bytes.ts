import { File as ExpoFile } from "expo-file-system";

/**
 * Reads a local file's bytes for an upload part. Kept out of api/client.ts,
 * which the repository's Node tests import without Expo modules installed.
 */
export function fileBytes(uri: string): () => Promise<Uint8Array> {
  return () => new ExpoFile(uri).bytes();
}
