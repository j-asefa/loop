import { afterAll, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "loop55-native-mcp-import-"));
const oldHome = process.env.HOME;
const oldPath = process.env.PATH;
process.env.HOME = join(root, "home");
process.env.PATH = join(root, "bin") + ":" + (oldPath || "");
process.env.LOOP55_DATA_DIR = join(root, "data");
process.env.LOOP55_ENCRYPTION_KEY = randomBytes(32).toString("hex");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(join(root, "bin"));
const codex = join(root, "bin", "codex");
writeFileSync(
  codex,
  '#!/bin/sh\nprintf \'%s\' \'[{"name":"codex-fixture","enabled":true,"transport":{"type":"stdio","command":"node","args":[],"env":{"API_KEY":"native-secret"},"env_vars":[],"cwd":null}}]\'\n',
);
chmodSync(codex, 0o755);
writeFileSync(
  join(process.env.HOME, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      "claude-fixture": {
        url: "https://tools.example/mcp",
        headers: { Authorization: "Bearer claude-secret" },
      },
    },
  }),
);
const { db, id } = await import("../src/server/db");
const { readSecret, withTestMcp } = await import("../src/server/mcp/client");
const { publicNativeMcpCandidates, importNativeMcpCandidate } =
  await import("../src/server/mcp/native-config-import");

afterAll(() => {
  db.close();
  process.env.HOME = oldHome;
  process.env.PATH = oldPath;
  rmSync(root, { recursive: true, force: true });
});

it("lists harness MCP names without browser-visible credentials and imports only the selected server", async () => {
  const candidates = await publicNativeMcpCandidates();
  expect(candidates.map((candidate) => candidate.name)).toContain(
    "claude-fixture",
  );
  expect(candidates.map((candidate) => candidate.name)).toContain(
    "codex-fixture",
  );
  expect(JSON.stringify(candidates)).not.toContain("native-secret");
  expect(JSON.stringify(candidates)).not.toContain("claude-secret");
  const chosen = candidates.find(
    (candidate) => candidate.name === "claude-fixture",
  )!;
  const restore = withTestMcp(
    async () =>
      ({
        getServerCapabilities: () => ({ tools: {} }),
        getServerVersion: () => ({ name: "Fixture", version: "1" }),
        listTools: async () => ({
          tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        }),
        close: async () => {},
      }) as any,
  );
  try {
    const installed = await importNativeMcpCandidate(id(), chosen.id);
    expect(installed[0].status).toBe("connected");
    const row = db
      .prepare("SELECT * FROM mcp_connections WHERE id=?")
      .get(installed[0].id) as any;
    expect(row.name).toBe("Claude · claude-fixture");
    expect(readSecret(row).headers?.Authorization).toBe("Bearer claude-secret");
  } finally {
    restore();
  }
});
