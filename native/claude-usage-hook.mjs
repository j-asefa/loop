import { captureClaudeUsage, claudeUsageFile } from "./subscription-usage.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

let input = "";
for await (const part of process.stdin) {
  input += part;
  if (input.length > 2_000_000) process.exit(1);
}
try {
  await captureClaudeUsage(input, process.argv[2] || claudeUsageFile(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")));
} catch {
  // Usage collection never interrupts Claude Code.
}
