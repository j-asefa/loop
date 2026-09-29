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
process.env.LOOP_PROFILE = "companion";
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");
const { nativeSignIns } = await import("../src/server/native-auth.js");

test("paired provider authentication protects credentials, checks project ownership, resumes and enables Claude without API fallback", async () => {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const originalPath = process.env.PATH;
  for (const name of ["codex", "claude", "pi", "opencode"]) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nexport LOOP_TEST_HARNESS=${name}\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
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
        credential: "bearer",
      }),
    });
    const { token } = (await redemption.json()) as any;
    const { csrf } = (await fetch(host.origin + "/session", {
      headers: { Authorization: "Bearer " + token },
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
          ...(authenticated ? { Authorization: "Bearer " + token } : {}),
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
    await until(() => !!nativeSignIns.status("claude").attempt?.prompt);
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
      () => nativeSignIns.status("claude").attempt?.state === "complete",
    );
    assert.equal((await api(base + "/status")).attempt.state, "complete");
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
    const piStart = await api(pi + "/start", {
      projectId,
      provider: "anthropic",
      method: "api",
      commandId: randomUUID(),
    });
    await until(() => !!nativeSignIns.status("pi").attempt?.prompt);
    const keyPrompt = (await api(pi + "/status")).attempt.prompt;
    const key = "fixture-super-private-provider-key";
    await api(pi + "/input", {
      attemptId: piStart.attempt.id,
      promptId: keyPrompt.id,
      value: key,
    });
    await until(() => nativeSignIns.status("pi").attempt?.state === "complete");
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
    ])
      assert.doesNotMatch(
        JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),
        /fixture-super-private|fixture-token-private|fixture-code/,
      );
    assert.equal((db.prepare("SELECT count(*) n FROM runs").get() as any).n, 0);
    await api("/workspace/runtimes/codex/auth/start", {
      projectId,
      provider: "openai",
      method: "oauth",
      commandId: randomUUID(),
    });
    await until(() => !!nativeSignIns.status("codex").attempt?.url);
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
