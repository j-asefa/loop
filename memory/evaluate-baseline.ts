import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { localEmbeddings, localModel } from "../src/server/local-embeddings.js";
const cases = JSON.parse(
  readFileSync(new URL("./fixtures-v1.json", import.meta.url), "utf8"),
) as string[][];
const start = performance.now();
const docs = await localEmbeddings(cases.map((c) => c[2]));
const preparationMs = performance.now() - start;
const times: number[] = [];
let matched = 0;
for (let i = 0; i < cases.length; i++) {
  const start = performance.now();
  const [query] = await localEmbeddings([cases[i][3]]);
  times.push(performance.now() - start);
  const ranked = docs
    .map((v, n) => ({
      n,
      score: v.reduce((sum, x, k) => sum + x * query[k], 0),
    }))
    .filter((v) => cases[v.n][0] === cases[i][0])
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (ranked.some((r) => r.n === i)) matched++;
}
const report = {
  corpus: "synthetic-v1-32",
  implementation: "existing Loop55 localEmbeddings (scoped cosine at 5)",
  model: localModel,
  questions: cases.length,
  recall5: matched,
  preparationMs: Math.round(preparationMs),
  warmP95Ms: Math.round(
    times.sort((a, b) => a - b)[Math.floor(0.95 * times.length)],
  ),
  hardware:
    "Host arm64; compare accuracy only with emulated amd64 MemSearch timings",
};
writeFileSync(
  "/private/tmp/loop55-memory-validation/baseline-evaluation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(report);
