import { join } from "node:path";
import { config } from "./config.js";

export const localModel = "local:all-MiniLM-L6-v2:q8";
let extractor: Promise<any> | undefined;
export async function localEmbeddings(texts: string[]): Promise<number[][]> {
  if (!extractor)
    extractor = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = join(config.data, "models");
      // A stalled first download must not hold the index worker indefinitely.
      env.fetch = (input, init = {}) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            AbortSignal.timeout(120000),
            ...(init.signal ? [init.signal] : []),
          ]),
        });
      return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "q8",
      });
    })().catch((error) => {
      extractor = undefined;
      throw error;
    });
  const model = await extractor;
  const output = await model(
    texts.map((t) => t.slice(0, 14000)),
    { pooling: "mean", normalize: true },
  );
  return output.tolist();
}
