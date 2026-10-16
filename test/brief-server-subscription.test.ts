import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { briefSubscriptionFixture } from "./helpers/brief-subscription";
const dir = mkdtempSync(join(tmpdir(), "loop-brief-server-test-"));
const bin = join(dir, "bin"),
  callsFile = join(dir, "calls"),
  token = "brief-runtime-fixture-token-at-least-32-characters";
mkdirSync(bin);
writeFileSync(callsFile, "");
for (const name of ["codex", "claude"]) {
  copyFileSync(resolve("test/fixtures/brief-harness.mjs"), join(bin, name));
  chmodSync(join(bin, name), 0o755);
}
vi.stubEnv("LOOP_PROFILE", "server");
vi.stubEnv("LOOP_DATA_DIR", join(dir, "db"));
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
vi.stubEnv("LOOP_RUNTIME_TOKEN", token);
const { db } = await import("../src/server/db");
const { runDueBriefs } = await import("../src/server/briefs/generate");
const { latestBriefUsage } = await import("../src/server/briefs/usage");
const { readState } = await import("../src/server/briefs/store");
const { serveBrief } = await import("../src/server/briefs/serve");
const { withTestAdapter } = await import("../src/server/providers");
const { seal } = await import("../src/server/secrets");
let host: ChildProcess,
  origin: string,
  diagnostics = "";
beforeAll(async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => reservation.once("listening", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  host = spawn(process.execPath, [resolve("runtime/host.mjs")], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      PORT: String(port),
      LOOP_RUNTIME_TOKEN: token,
      LOOP_RUNTIME_TOKEN_FILE: "",
      LOOP_RUNTIME_WORKDIR: dir,
      LOOP_TEST_BRIEF_CALLS: callsFile,
      LOOP_TEST_BRIEF_AUTH: "subscription",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  host.stderr!.on("data", (chunk) => (diagnostics += chunk));
  await vi.waitFor(
    async () =>
      expect(
        (
          await fetch(origin + "/health", {
            headers: { authorization: "Bearer " + token },
          })
        ).ok,
        diagnostics,
      ).toBe(true),
    { timeout: 10000 },
  );
  vi.stubEnv("LOOP_RUNTIME_URL", origin);
});
afterEach(() => {
  db.prepare("UPDATE brief_state SET enabled=0,due_at=NULL").run();
  vi.restoreAllMocks();
  vi.stubEnv("LOOP_RUNTIME_URL", origin);
});
afterAll(async () => {
  host?.kill();
  if (host?.exitCode === null)
    await new Promise<void>((resolve) => host.once("exit", () => resolve()));
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

for (const provider of ["codex", "anthropic"] as const) {
  it(`${provider}: runs a brief through the real subscription broker without API fallback`, async () => {
    const w = briefSubscriptionFixture(db, randomUUID(), provider);
    const api = vi.fn(),
      restore = withTestAdapter("anthropic", {
        async models() {
          return [];
        },
        async *stream() {
          api();
          throw new Error("No API fallback");
        },
      });
    const request = vi.spyOn(globalThis, "fetch");
    try {
      expect(await runDueBriefs()).toBe(1);
    } finally {
      restore();
    }
    expect(api).not.toHaveBeenCalled();
    expect(readState(w.owner, w.project).current_version).toBe(1);
    expect(serveBrief(w.owner, w.project).headline?.text).toBe(
      "Subscription brief",
    );
    expect(latestBriefUsage(w.owner, w.project)).toMatchObject({
      outcome: "published",
      attempts: 1,
      reported_attempts: 1,
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    });
    const dispatched = request.mock.calls.filter(([url]) =>
      String(url).endsWith("/runtime"),
    );
    expect(dispatched).toHaveLength(1);
    const sent = JSON.parse(String(dispatched[0][1]?.body));
    expect(sent).toMatchObject({
      action: "project-brief",
      input: { nativeTools: false, toolChoice: "submit_brief" },
    });
    expect(sent.githubToken).toBeUndefined();
  });
}

it("fails closed against an older broker instead of sending an ordinary native turn", async () => {
  const requests: any[] = [];
  const old = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(422);
      res.end(
        JSON.stringify({
          error:
            "Subscription runtime unavailable or request invalid. Check the runtime service and sign in again.",
        }),
      );
    });
  });
  old.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => old.once("listening", resolve));
  vi.stubEnv(
    "LOOP_RUNTIME_URL",
    `http://127.0.0.1:${(old.address() as any).port}`,
  );
  const w = briefSubscriptionFixture(db, randomUUID(), "codex");
  try {
    expect(await runDueBriefs()).toBe(0);
    expect(requests).toHaveLength(2);
    expect(
      requests.every((request) => request.action === "project-brief"),
    ).toBe(true);
    expect(readState(w.owner, w.project).current_version).toBe(0);
    expect(readState(w.owner, w.project).last_error).toContain(
      "No API fallback",
    );
    expect(readState(w.owner, w.project).last_error).toContain("Update");
  } finally {
    old.closeAllConnections();
    await new Promise<void>((resolve) => old.close(() => resolve()));
  }
});

it("uses the restricted ephemeral path for a remote Codex app-server", async () => {
  const { codexFixture, fixtureToken } = await import(
    resolve("test/helpers/codex-server.mjs")
  );
  const server = await codexFixture();
  server.setMode("brief");
  const w = briefSubscriptionFixture(db, randomUUID(), "codex");
  const runtime = randomUUID();
  vi.stubEnv("LOOP_ALLOWED_RUNTIME_ORIGINS", new URL(server.url).origin);
  db.prepare(
    "INSERT INTO runtime_hosts(id,owner_id,name,url,kind,secret,created_at) VALUES(?,?,'Codex fixture',?,'codex-app-server',?,0)",
  ).run(runtime, w.owner, server.url, seal(fixtureToken, w.owner));
  db.prepare(
    "UPDATE connections SET metadata=json_set(metadata,'$.runtimeHostId',?) WHERE id=?",
  ).run(runtime, w.connection);
  try {
    expect(await runDueBriefs()).toBe(1);
    const started = server.calls.find(
      (call: any) => call.method === "thread/start",
    );
    expect(started.params).toMatchObject({
      ephemeral: true,
      sandbox: "read-only",
      config: { "features.shell_tool": false, web_search: "disabled" },
    });
    const approvals = server.calls.filter((call: any) =>
      [1000, 1001, 1002, 1003].includes(call.id),
    );
    expect(approvals).toHaveLength(4);
    expect(approvals.every((call: any) => call.error?.code === -32601)).toBe(
      true,
    );
    expect(serveBrief(w.owner, w.project).headline?.text).toBe(
      "Remote subscription brief",
    );
  } finally {
    await server.close();
  }
});
