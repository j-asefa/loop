import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Named legacy exceptions, never a count or a glob. Remove entries alongside
// .prettierignore as files are formatted; reviewers reject additions here too.
const allowed = [
  "scripts/companion-browser-smoke.mjs",
  "scripts/conversation-history-smoke.mjs",
  "scripts/design-scenario.mjs",
  "scripts/feed-websocket-smoke.mjs",
  "src/client/App.tsx",
  "src/client/Conversation.tsx",
  "src/client/Feed.tsx",
  "src/client/MyProfile.tsx",
  "src/client/NativeControls.tsx",
  "src/client/SessionActivityControls.tsx",
  "src/client/agentSources.ts",
  "src/client/api.ts",
  "src/server/agent-runtime.ts",
  "src/server/core-routes.ts",
  "src/server/index.ts",
  "src/server/mobile-return.ts",
  "src/server/mobile-routes.ts",
  "src/server/row-schemas.ts",
  "src/server/workspace-events.ts",
  "src/shared/types.ts",
  "src/shared/workspace-api.ts",
  "src/shared/workspace-events.ts",
  "test/agent-mail.test.ts",
  "test/feed-projection.test.ts",
  "test/mobile-return.test.ts",
  "test/native-auth-api.node.test.ts",
  "test/projection-sockets.test.ts",
  "test/streaming-writes.test.ts",
  "test/workspace-event-contract.test.ts",
  "test/workspace-events.test.ts",
];

it("keeps formatting exceptions explicit and limited to the named legacy list", () => {
  const ignored = readFileSync(
    new URL("../.prettierignore", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  expect(ignored.sort()).toEqual([...allowed].sort());
  for (const path of ignored) {
    expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
  }
});
