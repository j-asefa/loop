#!/usr/bin/env node
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const data =
    request.type === "get_commands"
      ? {
          commands: [
            {
              name: "review",
              source: "prompt",
              description: "Review changes",
              sourceInfo: {
                path: process.cwd() + "/.pi/prompts/review.md",
                scope: "project",
              },
            },
          ],
        }
      : { model: { provider: "fixture", id: "model" }, thinkingLevel: "low" };
  process.stdout.write(
    JSON.stringify({ id: request.id, success: true, data }) + "\n",
  );
}
