process.env.LOOP_PROFILE = "companion";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "./helpers.js";
import { gitProject } from "./git-project.js";
await mkdir(".tmp", { recursive: true });
const dir = await mkdtemp(join(resolve(".tmp"), "loop-start-runtimes-"));
gitProject(dir);
process.env.LOOP_DATA_DIR = dir;
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");

test("runtime-neutral paired host enables and dispatches all fixture runtimes through app APIs", async () => {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const originalPath = process.env.PATH;
  const names = ["codex", "claude", "pi", "opencode", "gemini"] as const;
  // Stable releases from the registry at the time of this regression. Discovery
  // must accept updates, then still perform normal adapter/authentication setup.
  const versions = {
    codex: "0.159.0",
    claude: "2.1.284",
    pi: "0.87.1",
    opencode: "1.18.33",
    gemini: "0.64.0",
  };
  for (const name of names) {
    if (name === "gemini") {
      await writeFile(
        join(bin, name),
        `#!/bin/sh\nexport LOOP_TEST_GEMINI_AUTO=1\nexec '${process.execPath}' '${resolve("test/fixtures/fake-gemini.mjs")}' "$@"\n`,
        { mode: 0o755 },
      );
      continue;
    }
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nexport LOOP_TEST_HARNESS=${name}\nexport LOOP_TEST_CLAUDE_AUTH=oauth\nexport LOOP_TEST_HARNESS_VERSION=${versions[name]}\nexec '${process.execPath}' '${resolve("test/harness.mjs")}' "$@"\n`,
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
  let host = new WorkspaceHost(dir, options);
  try {
    const { prepareLocalHarnesses } =
      await import("../src/server/local-harnesses.js");
    await host.start(
      options,
      undefined,
      () => prepareLocalHarnesses(dir, [...names]),
      true,
    );
    const secret = new URL(host.pair().url).hash.slice(6);
    const redemption = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: host.origin },
      body: JSON.stringify({ secret, name: "fixture" }),
    });
    assert.equal(redemption.status, 200);
    const cookie = redemption.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await fetch(host.origin + "/session", {
      headers: { cookie, Origin: host.origin },
    }).then((r) => r.json())) as any;
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(host.origin + "/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          Origin: host.origin,
          "x-loop-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = (await response.json()) as any;
      assert(response.ok, JSON.stringify({ path, result }));
      return result;
    };
    assert.equal((await api("/workspace")).harnesses.length, names.length);
    const projectId = (await api("/workspace")).projectPaths[0].folder_id;
    const runtimes = (await api("/workspace/runtimes")).runtimes;
    for (const name of names) {
      const runtime = runtimes.find((r: any) => r.name === name);
      assert.equal(runtime?.available, true, name);
      assert.equal(runtime.version, versions[name]);
    }
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-private-value-must-not-leak";
    try {
      // Child environments are fixed at launch, as in the installed CLI.
      await host.close();
      host = new WorkspaceHost(dir, options);
      await host.start(options, undefined, undefined, true);
      const failure = await fetch(
        host.origin + "/api/workspace/runtimes/codex/enable",
        {
          method: "POST",
          headers: {
            cookie,
            Origin: host.origin,
            "x-loop-csrf": csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ projectId, billing: "subscription" }),
        },
      );
      assert.equal(failure.status, 503);
      const refusal = await failure.json();
      assert.equal(refusal.executionOutcome, "refused");
      assert.match(refusal.error, /No prompt was sent/);
      assert.match(refusal.error, /Provider connections/);
      assert.doesNotMatch(JSON.stringify(refusal), /fixture-private-value/);
      assert.equal((await api("/workspace")).harnesses.length, names.length);
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      await host.close();
      host = new WorkspaceHost(dir, options);
      await host.start(options, undefined, undefined, true);
    }
    for (const name of names) {
      await api(`/workspace/runtimes/${name}/enable`, {
        projectId,
        billing:
          name === "codex" || name === "claude" ? "subscription" : "existing",
      });
      const input = {
        name: "app-" + name,
        connectionId: "native-" + name,
        model: "native-default",
        folderId: projectId,
        instructions: "",
        initialPrompt: "hello",
        idempotencyKey: randomUUID(),
      };
      const created = await api("/agents", input);
      assert.equal((await api("/agents", input)).id, created.id);
      await until(
        () =>
          !!db
            .prepare(
              "SELECT 1 FROM runs WHERE agent_id=? AND state='completed'",
            )
            .get(created.id),
        30000,
      );
      const binding = db
        .prepare(
          "SELECT n.* FROM companion_sessions n JOIN conversations c ON c.id=n.conversation_id WHERE c.agent_id=?",
        )
        .get(created.id) as any;
      assert.equal(binding.harness, name);
      assert(binding.native_id);
      for (const path of ["/results", `/results?agent=${created.id}`]) {
        const result = (await api(path)).items.find(
          (item: any) => item.run_id === created.initialRun.id,
        );
        assert.equal(result?.content, "Fixture done");
      }
      const updates = await api(
        `/results/updates?agent=${created.id}&after=0&through=0`,
      );
      assert(
        updates.items.some(
          (item: any) =>
            item.run_id === created.initialRun.id &&
            item.content === "Fixture done",
        ),
      );
      assert.equal(
        (
          db
            .prepare("SELECT count(*) n FROM runs WHERE agent_id=?")
            .get(created.id) as any
        ).n,
        1,
      );
      await api("/runs", {
        agentId: created.id,
        conversationId: created.initialRun.conversation_id,
        input: "follow up",
        idempotencyKey: randomUUID(),
      });
      await until(
        () =>
          (
            db
              .prepare(
                "SELECT count(*) n FROM runs WHERE agent_id=? AND state='completed'",
              )
              .get(created.id) as any
          ).n === 2,
        30000,
      );
    }
  } finally {
    await host.close();
    process.env.PATH = originalPath;
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
