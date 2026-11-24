// The only addresses Loop opens as a file's bytes: an artifact's file or a
// stored object, on this workspace or one of its agent sources. Previews and
// card thumbnails share this check, so neither loads another address.

export const LOOP_ARTIFACT_FILE_PATH =
  /^\/api\/(?:agent-sources\/([^/]+)\/)?artifacts\/([^/?#]+)\/file(?:\?[^#]*)?$/;
export const LOOP_OBJECT_PATH =
  /^\/api\/(?:agent-sources\/([^/]+)\/)?objects\/([^/?#]+)(?:\?[^#]*)?$/;

export function isLoopFilePath(url: string) {
  return LOOP_ARTIFACT_FILE_PATH.test(url) || LOOP_OBJECT_PATH.test(url);
}
