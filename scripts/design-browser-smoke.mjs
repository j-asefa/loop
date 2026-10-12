// Each scenario owns its database, server and browser context. Child processes
// also isolate helper-level environment mutations. Existing smoke:design stays full.
import { spawn } from "node:child_process";
const names = [
  "agent-mail",
  "brief",
  "execution-environments",
  "main-composer-keyboard",
  "clear-search",
  "feed-reply-keyboard",
  "safari-sheet-keyboard",
  "create-agent-layout",
  "core",
  "withdraw-draft",
  "upload-destination",
  "inbox",
  "needs-stack",
  "continuity-320",
  "continuity-390",
  "reply-keyboard",
  "dialog-keyboard",
  "settings",
  "workspace",
  "teams",
  "team-presets",
  "profile",
  "models",
  "swipe",
  "done-card-dismissal",
  "messages",
  "files",
  "profile-work",
  "conversation-live",
  "thread-layout",
];
const selected = process.argv.slice(2);
if (selected.some((name) => !names.includes(name)))
  throw new Error("Unknown design scenario");
const queue = selected.length ? selected : names;
const workers = Number(process.env.LOOP_BROWSER_WORKERS || 2);
if (![1, 2].includes(workers))
  throw new Error("LOOP_BROWSER_WORKERS must be 1 or 2");
const children = new Set();
let failed = false,
  next = 0;
const stop = (signal) => {
  for (const child of children) child.kill(signal);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stop(signal);
    process.exitCode = 1;
    failed = true;
  });
async function worker() {
  while (next < queue.length && !failed) {
    const name = queue[next++];
    const child = spawn(
      process.execPath,
      ["scripts/design-scenario.mjs", name],
      { stdio: "inherit", env: process.env },
    );
    children.add(child);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    children.delete(child);
    if (code !== 0) {
      failed = true;
      process.exitCode = 1;
    }
  }
}
const started = performance.now();
await Promise.all(Array.from({ length: workers }, worker));
console.log(
  `Design suite: ${((performance.now() - started) / 1000).toFixed(1)}s, workers=${workers}`,
);
