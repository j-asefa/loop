import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { briefSubscriptionFixture } from "./helpers/brief-subscription";
const dir = mkdtempSync(join(tmpdir(), "loop-brief-native-test-"));
const callsFile = join(dir, "calls");
const executable = resolve("test/fixtures/brief-harness.mjs");
chmodSync(executable, 0o755);
vi.stubEnv("LOOP_PROFILE", "companion");
vi.stubEnv("LOOP_DATA_DIR", dir);
vi.stubEnv("LOOP_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
vi.stubEnv("LOOP_TEST_BRIEF_CALLS", callsFile);
vi.stubEnv("LOOP_TEST_BRIEF_PROJECT", dir);
for (const key of [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
])
  vi.stubEnv(key, "");
const { db } = await import("../src/server/db");
const { runDueBriefs } = await import("../src/server/briefs/generate");
const { readState } = await import("../src/server/briefs/store");
const { serveBrief } = await import("../src/server/briefs/serve");
const owner = "local-workspace";
const calls = () =>
  readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
function fixture(provider: "codex" | "anthropic", model = "fixture") {
  writeFileSync(callsFile, "");
  const harness = provider === "codex" ? "codex" : "claude";
  db.prepare(
    "INSERT OR REPLACE INTO harnesses(name,options,billing,models,capabilities,updated_at) VALUES(?,?,'{}','[]','{}',0)",
  ).run(
    harness,
    JSON.stringify({
      harness,
      executable,
      project: dir,
      billing: "subscription",
      version: "fixture",
    }),
  );
  return briefSubscriptionFixture(db, owner, provider, true, model);
}
afterEach(() => {
  db.prepare("UPDATE brief_state SET enabled=0,due_at=NULL").run();
  vi.stubEnv("LOOP_TEST_BRIEF_AUTH", "subscription");
  vi.stubEnv("LOOP_TEST_BRIEF_DEFAULT", "");
});
afterAll(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

for (const provider of ["codex", "anthropic"] as const) {
  it(`${provider}: publishes through the registered subscription with native actions disabled`, async () => {
    const w = fixture(provider);
    expect(await runDueBriefs()).toBe(1);
    expect(readState(owner, w.project).current_version).toBe(1);
    expect(serveBrief(owner, w.project).headline?.text).toBe(
      "Subscription brief",
    );
    const launches = calls().filter((call) => call.args);
    expect(launches.length).toBeGreaterThan(0);
    expect(
      launches.every((call) => call.cwd !== dir && !existsSync(call.cwd)),
    ).toBe(true);
    expect(
      db.prepare("SELECT count(*) n FROM companion_sessions").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM approvals").get()).toEqual({
      n: 0,
    });
    if (provider === "codex") {
      expect(
        calls().find((call) => call.rpc?.id === "ungranted-action").rpc.error
          .code,
      ).toBe(-32601);
      expect(calls().some((call) => call.rpc?.method === "thread/resume")).toBe(
        false,
      );
    }
  });
  it(`${provider}: refuses API-key sign-in without any model request`, async () => {
    const w = fixture(provider);
    vi.stubEnv("LOOP_TEST_BRIEF_AUTH", "api");
    expect(await runDueBriefs()).toBe(0);
    expect(readState(owner, w.project).last_error).toContain("No API fallback");
    expect(calls().some((call) => call.prompt)).toBe(false);
  });
  it(`${provider}: aborts the isolated process and reschedules read-only work`, async () => {
    const w = fixture(provider, "wait"),
      controller = new AbortController();
    const running = runDueBriefs(undefined, controller.signal);
    await vi.waitFor(() =>
      expect(calls().some((call) => call.prompt)).toBe(true),
    );
    controller.abort();
    expect(await running).toBe(0);
    expect(readState(owner, w.project)).toMatchObject({
      current_version: 0,
      generation_id: null,
    });
    expect(readState(owner, w.project).due_at).not.toBeNull();
    for (const launch of calls().filter((call) => call.args))
      expect(existsSync(launch.cwd)).toBe(false);
  });
  it(`${provider}: retains the selected model and refuses alternate billing configuration`, async () => {
    const w = fixture(
      provider,
      provider === "codex" ? "native-default" : "fixture",
    );
    expect(await runDueBriefs()).toBe(1);
    expect(readState(owner, w.project).current_version).toBe(1);
    if (provider === "codex") {
      expect(
        calls().some(
          (call) =>
            call.rpc?.method === "config/read" && call.rpc.params.cwd === dir,
        ),
      ).toBe(true);
      const started = calls().find(
        (call) => call.rpc?.method === "thread/start",
      ).rpc.params;
      expect(started.model).toBe("project-default");
      expect(started.cwd).not.toBe(dir);
    } else {
      const args = calls().find((call) => call.args?.includes("--model")).args;
      expect(args[args.indexOf("--model") + 1]).toBe("fixture");
    }
    fixture(provider);
    vi.stubEnv("LOOP_TEST_BRIEF_AUTH", "alternate");
    expect(await runDueBriefs()).toBe(0);
    expect(calls().some((call) => call.prompt)).toBe(false);
  });
}

it("requires an explicit Claude model before launching a brief", async () => {
  const w = fixture("anthropic", "native-default");
  expect(await runDueBriefs()).toBe(0);
  expect(readState(owner, w.project).last_error).toContain(
    "specific Claude model",
  );
  expect(calls()).toEqual([]);
});

it("uses the account catalog default when the registered Codex project has no configured model", async () => {
  const w = fixture("codex", "native-default");
  vi.stubEnv("LOOP_TEST_BRIEF_DEFAULT", "catalog");
  expect(await runDueBriefs()).toBe(1);
  expect(readState(owner, w.project).current_version).toBe(1);
  expect(
    calls().find((call) => call.rpc?.method === "thread/start").rpc.params
      .model,
  ).toBe("catalog-default");
});

it("refuses a Codex runtime that does not confirm the requested sandbox", async () => {
  const w = fixture("codex", "unsafe");
  expect(await runDueBriefs()).toBe(0);
  expect(readState(owner, w.project).current_version).toBe(0);
  expect(calls().some((call) => call.prompt)).toBe(false);
});

it("retries validation once and discards generation after an owner edit", async () => {
  const retry = fixture("codex", "retry");
  expect(await runDueBriefs()).toBe(1);
  expect(readState(owner, retry.project).current_version).toBe(1);
  expect(calls().filter((call) => call.prompt)).toHaveLength(2);
  const w = fixture("anthropic", "slow");
  const running = runDueBriefs();
  await vi.waitFor(() =>
    expect(calls().some((call) => call.prompt)).toBe(true),
  );
  db.prepare(
    "UPDATE brief_state SET owner_edit_rev=owner_edit_rev+1 WHERE project_id=?",
  ).run(w.project);
  expect(await running).toBe(0);
  expect(readState(owner, w.project).current_version).toBe(0);
});

it("refuses another owner and unverified native billing before launch", async () => {
  writeFileSync(callsFile, "");
  const other = briefSubscriptionFixture(db, "other-owner", "codex", true);
  expect(await runDueBriefs()).toBe(0);
  expect(readState(other.owner, other.project).last_error).toContain(
    "cannot run a native",
  );
  const w = fixture("codex");
  db.prepare(
    "UPDATE harnesses SET options=json_set(options,'$.billing','existing') WHERE name='codex'",
  ).run();
  expect(await runDueBriefs()).toBe(0);
  expect(readState(owner, w.project).last_error).toContain(
    "Verify this harness",
  );
  expect(calls()).toEqual([]);
});
