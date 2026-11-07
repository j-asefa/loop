// Each scenario owns its database, server and browser context. Child processes
// also isolate helper-level environment mutations. Existing smoke:design stays full.
import { runSupervised } from "./heavy-command.mjs";
const names = [
  "beginner-chat",
  "create-agent-models",
  "profile-photos-recipient",
  "visual-layout",

  "antigravity",
  "harness-providers",
  "agent-mail",
  "agent-thread-feed",
  "workspace-project",
  "execution-environments",
  "main-composer-keyboard",
  "composer-typing",
  "clear-search",
  "search-categories",
  "feed-reply-keyboard",
  "mobile-nav-viewport",
  "feed-reading",
  "feed-threads",
  "feed-loading",
  "safari-sheet-keyboard",
  "create-agent-layout",
  "core",
  "withdraw-draft",
  "upload-destination",
  "attachment-picker",
  "feed",
  "card-reminders",
  "needs-stack",
  "continuity-320",
  "continuity-390",
  "continuation",
  "continuation-tabs",
  "continuation-recovery",
  "reply-keyboard",
  "dialog-keyboard",
  "settings",
  "workspace",
  "teams",
  "team-feed-visibility",
  "team-presets",
  "markdown-definitions",
  "markdown-models",
  "markdown-source",
  "profile",
  "personal-decisions",
  "models",
  "swipe",
  "done-card-dismissal",
  "done-card-actions",
  "done-feed-filters",
  "steering-replies",
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
const workers = Number(process.env.LOOP_BROWSER_WORKERS || 1);
if (![1, 2].includes(workers))
  throw new Error("LOOP_BROWSER_WORKERS must be 1 or 2");
const controller = new AbortController();
let failed = false,
  next = 0;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    controller.abort();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    failed = true;
  });
async function worker() {
  while (next < queue.length && !failed) {
    const name = queue[next++];
    const code = await runSupervised(
      process.execPath,
      ["scripts/design-scenario.mjs", name],
      {
        label: `design/${name}`,
        signal: controller.signal,
      },
    );
    // Cancelling siblings must not replace the failure that stopped the suite.
    if (code !== 0 && !failed) {
      failed = true;
      process.exitCode = code;
      controller.abort();
    }
  }
}
const started = performance.now();
await Promise.all(Array.from({ length: workers }, worker));
console.log(
  `Design suite: ${((performance.now() - started) / 1000).toFixed(1)}s, workers=${workers}`,
);
