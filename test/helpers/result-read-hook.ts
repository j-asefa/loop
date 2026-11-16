import { mock } from "node:test";

let afterRead: (() => void) | undefined;
export function armResultReadHook(callback?: () => void) {
  afterRead = callback;
}

// Install before the HTTP reader imports its query module. The real revision
// read establishes the snapshot before the one-shot foreign writer runs.
export async function installResultReadHook(module: URL) {
  const original: typeof import("../../src/server/sql/feed-revisions.js") =
    await import(module.href);
  mock.module(module.href, {
    namedExports: {
      ...original,
      revision: (...args: Parameters<typeof original.revision>) => {
        const revision = original.revision(...args);
        const callback = afterRead;
        afterRead = undefined;
        callback?.();
        return revision;
      },
    },
  });
}
