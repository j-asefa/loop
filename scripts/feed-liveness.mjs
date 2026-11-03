// Reads every feed in the catalog through the code that serves it, so a feed
// that has gone (or started asking for an account) is found here rather than
// by someone opening Social. Needs network access; it is not part of CI.
import { feedCatalog } from "../src/shared/news.ts";
import { download } from "../src/server/feed-fetch.ts";

const CONCURRENT = 4;
// Reading stops once a feed has the stories Loop keeps, so size is only worth
// mentioning when a feed is enormous. This script measures the whole response,
// which is more than Loop downloads.
const WARN_BYTES = 6_000_000;

let bytes = 0;
const sizes = new Map();
const { withFeedFetch } = await import("../src/server/feed-fetch.ts");
// Measure each response without changing how it is read.
withFeedFetch(async (url, init) => {
  const response = await fetch(url, init);
  const body = await response.arrayBuffer();
  bytes += body.byteLength;
  sizes.set(url, body.byteLength);
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
});

const queue = [...feedCatalog];
const results = [];
async function worker() {
  for (let feed; (feed = queue.shift());) {
    const started = Date.now();
    try {
      const answer = await download(feed);
      results.push({
        feed,
        stories: answer.modified ? answer.stories.length : 0,
        bytes: sizes.get(feed.url) ?? 0,
        ms: Date.now() - started,
      });
    } catch (error) {
      results.push({
        feed,
        stories: 0,
        bytes: sizes.get(feed.url) ?? 0,
        ms: Date.now() - started,
        error: error.message,
      });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENT }, worker));
results.sort((a, b) => a.feed.id.localeCompare(b.feed.id));

const failures = results.filter((r) => r.error);
const large = results.filter((r) => !r.error && r.bytes > WARN_BYTES);
for (const r of results)
  console.log(
    [
      r.feed.id.padEnd(24),
      r.feed.category.padEnd(14),
      String(r.stories).padStart(3),
      (r.bytes ? (r.bytes / 1000).toFixed(0) + " kB" : "").padStart(9),
      String(r.ms).padStart(6) + " ms",
      r.error || "",
    ].join(" "),
  );
console.log(
  `\n${results.length - failures.length}/${results.length} feeds read, ${(
    bytes / 1_000_000
  ).toFixed(1)} MB transferred.`,
);
for (const r of large)
  console.warn(
    `warning: ${r.feed.id} is ${(r.bytes / 1_000_000).toFixed(1)} MB.`,
  );
if (failures.length) {
  console.error(`\n${failures.length} feed(s) could not be read:`);
  for (const r of failures) console.error(`  ${r.feed.id}: ${r.error}`);
  process.exitCode = 1;
}
