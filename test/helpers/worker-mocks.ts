// Factories for vi.mock. Load them inside the hoisted factory with a dynamic
// import, for example:
//   vi.mock("../src/server/search", async () =>
//     (await import("./helpers/worker-mocks.js")).noSearchIndexing());

/** Worker tests exercise the queue; background search indexing is out of scope. */
export function noSearchIndexing() {
  return { indexPending: async () => {} };
}

/** Keeps the real memory module but skips capture after each run. */
export async function noMemoryCapture<T extends object>(
  original: () => Promise<T>,
) {
  return { ...(await original()), captureMemory: () => {} };
}

/** A local embedding model that maps every text to the same vector. */
export function fixedLocalEmbeddings(localModel: string) {
  return {
    localModel,
    localEmbeddings: async (texts: string[]) => texts.map(() => [1, 0]),
  };
}
