import { File as ExpoFile, Paths } from "expo-file-system";
import { createSnippetUsageStore } from "./snippet-usage-codec";

export {
  computeKeyboardInset,
  computeQuickSheetLayout,
  createEmptySnippetUsageMap,
  mergeSnippetUsageMaps,
  recordSnippetUseInStore,
  sortSnippetsByUsage,
  type SnippetUsageEntry,
  type SnippetUsageMap,
} from "./snippet-usage-codec";

function usageFileForBucket(bucket: string): ExpoFile {
  return new ExpoFile(Paths.cache, `loop-snippet-usage-${bucket}.json`);
}

const store = createSnippetUsageStore({
  async readText(bucket) {
    const file = usageFileForBucket(bucket);
    return file.exists ? file.text() : null;
  },
  writeText(bucket, raw) {
    usageFileForBucket(bucket).write(raw);
  },
  deleteFile(bucket) {
    const file = usageFileForBucket(bucket);
    if (file.exists) file.delete();
  },
});

export const loadSnippetUsage = store.loadSnippetUsage;
export const recordSnippetUse = store.recordSnippetUse;
export const clearWorkspaceSnippetUsage = store.clearWorkspaceSnippetUsage;
