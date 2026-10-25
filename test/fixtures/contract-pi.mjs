#!/usr/bin/env node
// Isolated Pi protocol/CLI fixture. No provider, package registry or user files.
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
const [action, source] = process.argv.slice(2);
if (["install", "remove", "update"].includes(action)) {
  const file = join(process.argv.includes("--local") ? join(process.cwd(), ".pi") : process.env.PI_CODING_AGENT_DIR, "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  const key = value => (typeof value === "string" ? value : value.source).replace(/@[^@/]+$/, "");
  settings.packages = (settings.packages || []).filter(value => key(value) !== key(source));
  if (action !== "remove") settings.packages.push(source);
  writeFileSync(file, JSON.stringify(settings));
  process.exit(0);
}
writeSync(3, JSON.stringify({ configured: true, subscription: true, provider: "openai-codex", model: "fixture", modelBilling: [{ id: "openai-codex/fixture", subscription: true }] }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const data = request.type === "get_state"
    ? { model: { provider: "openai-codex", id: "fixture" }, thinkingLevel: "off" }
    : request.type === "get_available_models"
      ? { models: [{ provider: "openai-codex", id: "fixture", name: "Fixture" }] }
      : request.type === "get_commands"
        ? { commands: [{ name: "review", source: "prompt", description: "Review changes", sourceInfo: { path: join(process.cwd(), ".pi/prompts/review.md"), scope: "project", packageId: "fixture" } }] }
        : request.type === "get_available_thinking_levels" ? { levels: ["off"] } : {};
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data }) + "\n");
}
