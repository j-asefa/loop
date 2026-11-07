import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "./helpers.js";
await mkdir(".tmp", { recursive: true });
const dir = await mkdtemp(resolve(".tmp/native-auth-api-"));
process.env.LOOP_DATA_DIR = dir;
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");

test("paired provider authentication protects credentials, checks project ownership, resumes and enables Claude without API fallback", async () => {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const originalPath = process.env.PATH;
  for (const name of ["codex", "claude", "pi", "opencode", "muse", "grok"]) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nexport LOOP_TEST_HARNESS=${name}\nexport LOOP_TEST_AUTH_DIR='${dir}'\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
      { mode: 0o755 },
    );
  }
  process.env.PATH = bin + ":" + originalPath;
  const options = {
    harness: "codex" as const,
    executable: "codex",
    project: dir,
    version: "workspace",
    billing: "existing" as const,
  };
  const host = new WorkspaceHost(dir, options);
  try {
    await host.start(options, undefined, undefined, true);
    const secret = new URL(host.pair().url).hash.slice(6);
    const redemption = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: host.origin },
      body: JSON.stringify({
        secret,
        name: "sign-in test",
      }),
    });
    assert.equal(redemption.status, 200);
    const cookie = redemption.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await fetch(host.origin + "/session", {
      headers: { cookie, Origin: host.origin },
    }).then((r) => r.json())) as any;
    const request = (
      path: string,
      body?: unknown,
      authenticated = true,
      validCsrf = true,
    ) =>
      fetch(host.origin + "/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { cookie, Origin: host.origin } : {}),
          ...(validCsrf ? { "x-loop-csrf": csrf } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const api = async (path: string, body?: unknown) => {
      const response = await request(path, body);
      const data = (await response.json()) as any;
      assert(response.ok, JSON.stringify({ path, data }));
      return data;
    };
    const projectId = (await api("/workspace")).projectPaths[0].folder_id;
    const base = "/workspace/runtimes/claude/auth";
    const body = {
      projectId,
      provider: "anthropic",
      method: "oauth",
      commandId: randomUUID(),
    };
    assert.equal(
      (await request(base + "?projectId=" + projectId, undefined, false))
        .status,
      401,
    );
    assert.equal(
      (await request(base + "/start", body, true, false)).status,
      403,
    );
    db.prepare(
      "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES('foreign','different-owner','Other','project',0)",
    ).run();
    assert.equal(
      (await request(base + "/start", { ...body, projectId: "foreign" }))
        .status,
      404,
    );
    assert.equal(
      (await request(base + "/start", { ...body, executable: "/bin/sh" }))
        .status,
      400,
    );
    const catalog = await request(base + "?projectId=" + projectId);
    assert.equal(catalog.headers.get("cache-control"), "no-store");
    assert.equal(((await catalog.json()) as any).providers[0].id, "anthropic");
    const started = await api(base + "/start", body);
    assert.equal(started.attempt.commandId, body.commandId);
    await until(async () => !!(await api(base + "/status")).attempt?.prompt);
    const waitingCommand = { ...body, commandId: randomUUID() };
    assert.equal((await request(base + "/start", waitingCommand)).status, 409);
    const resumed = await api(base + "?projectId=" + projectId);
    assert.equal(resumed.attempt.id, started.attempt.id);
    assert.equal(
      (await api(base + "/start", body)).attempt.id,
      started.attempt.id,
    );
    const answer = {
      attemptId: resumed.attempt.id,
      promptId: resumed.attempt.prompt.id,
      value: "fixture-code",
    };
    assert.equal(
      (await request(base + "/input", { ...answer, value: "code\ninjected" }))
        .status,
      400,
    );
    const accepted = await api(base + "/input", answer);
    assert.doesNotMatch(JSON.stringify(accepted), /fixture-code/);
    assert.equal((await request(base + "/input", answer)).status, 409);
    await until(
      async () => (await api(base + "/status")).attempt?.state === "complete",
    );
    const complete = (await api(base + "/status")).attempt;
    assert.equal(complete.state, "complete");
    assert.equal(complete.commandId, body.commandId);
    const afterWait = await api(base + "/start", waitingCommand);
    assert.equal((await request(base + "/start", body)).status, 409);
    await api(base + "/cancel", { attemptId: afterWait.attempt.id });
    await api("/workspace/runtimes/claude/enable", {
      projectId,
      billing: "subscription",
    });
    assert(
      (await api("/workspace")).harnesses.some(
        (runtime: any) => runtime.name === "claude",
      ),
    );
    const pi = "/workspace/runtimes/pi/auth";
    const piCommand = {
      projectId,
      provider: "anthropic",
      method: "api",
      commandId: randomUUID(),
    };
    await writeFile(
      join(dir, "refuse-auth-providers"),
      "fail before login starts",
    );
    try {
      assert.equal((await request(pi + "/start", piCommand)).status, 422);
    } finally {
      await rm(join(dir, "refuse-auth-providers"));
    }
    const piStart = await api(pi + "/start", piCommand);
    await until(
      async () =>
        !!(await api("/workspace/runtimes/pi/auth/status")).attempt?.prompt,
    );
    const keyPrompt = (await api(pi + "/status")).attempt.prompt;
    const key = "fixture-super-private-provider-key";
    await api(pi + "/input", {
      attemptId: piStart.attempt.id,
      promptId: keyPrompt.id,
      value: key,
    });
    await until(
      async () =>
        (await api("/workspace/runtimes/pi/auth/status")).attempt?.state ===
        "complete",
    );
    assert.doesNotMatch(
      JSON.stringify(await api(pi + "/status")),
      /fixture-super-private|fixture-private/,
    );
    assert.equal(
      JSON.parse(await readFile(join(dir, "pi-credential.json"), "utf8")).key,
      key,
    );
    // Auth exchanges are not messages, traces or workspace events, and raw
    // provider credentials appear only in the harness's own fixture store.
    for (const table of [
      "messages",
      "run_traces",
      "events",
      "harnesses",
      "connections",
      "execution_commands",
    ])
      assert.doesNotMatch(
        JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),
        /fixture-super-private|fixture-token-private|fixture-code/,
      );
    assert.equal((db.prepare("SELECT count(*) n FROM runs").get() as any).n, 0);
    const muse = "/workspace/runtimes/muse/auth";
    await api(muse + "/start", {
      projectId,
      provider: "meta",
      method: "oauth",
      commandId: randomUUID(),
    });
    await until(async () => !!(await api(muse + "/status")).attempt?.url);
    assert.equal(
      new URL((await api(muse + "/status")).attempt.url).hostname,
      "auth.meta.com",
    );
    await writeFile(join(dir, "authorize-muse"), "yes");
    await until(
      async () => (await api(muse + "/status")).attempt?.state === "complete",
    );
    // Grok's device code reaches the phone only from its own sign-in host.
    const grok = "/workspace/runtimes/grok/auth";
    await api(grok + "/start", {
      projectId,
      provider: "xai",
      method: "oauth",
      commandId: randomUUID(),
    });
    await until(async () => !!(await api(grok + "/status")).attempt?.url);
    const grokAttempt = (await api(grok + "/status")).attempt;
    assert.equal(new URL(grokAttempt.url).hostname, "accounts.x.ai");
    assert.equal(grokAttempt.code, "KSXH-JR4E");
    await writeFile(join(dir, "authorize-grok"), "yes");
    await until(
      async () => (await api(grok + "/status")).attempt?.state === "complete",
    );
    assert.match(await readFile(join(dir, "auth-audit"), "utf8"), /grok:login/);
    await api("/workspace/runtimes/codex/auth/start", {
      projectId,
      provider: "openai",
      method: "oauth",
      commandId: randomUUID(),
    });
    await until(
      async () =>
        !!(await api("/workspace/runtimes/codex/auth/status")).attempt?.url,
    );
    const pending = (await api("/workspace/runtimes/codex/auth/status"))
      .attempt;
    await api("/workspace/runtimes/codex/auth/cancel", {
      attemptId: pending.id,
    });
    assert.equal(
      (await api("/workspace/runtimes/codex/auth/status")).attempt.state,
      "cancelled",
    );
    assert(!(await readdir(dir)).includes("codex-credential.json"));
  } finally {
    await host.close();
    process.env.PATH = originalPath;
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
