import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "./helpers.js";

await mkdir(".tmp", { recursive: true });
const dir = await mkdtemp(resolve(".tmp/provider-management-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_PROFILE = "companion";
const { WorkspaceHost } = await import("../src/workspace-host.js");
const { db } = await import("../src/server/db.js");

test("native provider settings save independent keys, preserve billing, refresh models, remove credentials and reconcile uncertain writes", async () => {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const originalPath = process.env.PATH;
  for (const name of ["pi", "opencode"])
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nexport LOOP_TEST_HARNESS=${name}\nexport LOOP_TEST_PROVIDER_DIR='${dir}'\nexec '${process.execPath}' '${resolve("test/fixtures/provider-harness.mjs")}' "$@"\n`,
      { mode: 0o755 },
    );
  process.env.PATH = bin + ":" + originalPath;
  const options = {
    harness: "codex" as const,
    executable: resolve("test/harness.mjs"),
    project: dir,
    version: "workspace",
    billing: "existing" as const,
  };
  const host = new WorkspaceHost(dir, options);
  try {
    await host.start(options, undefined, undefined, true);
    const pair = await fetch(host.origin + "/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: host.origin },
      body: JSON.stringify({
        secret: new URL(host.pair().url).hash.slice(6),
        name: "provider test",
      }),
    });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get("set-cookie")!.split(";")[0];
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
      const value = (await response.json()) as any;
      assert(response.ok, JSON.stringify({ path, value }));
      assert.doesNotMatch(
        JSON.stringify(value),
        /fixture-private|super-secret|oauth-secret/,
      );
      return value;
    };
    const projectId = (await api("/workspace")).projectPaths[0].folder_id;
    const base = (name: string) => `/workspace/runtimes/${name}/providers`;
    const key = (name: string, provider = "openrouter") => ({
      projectId,
      provider,
      method: name === "pi" ? "api" : "0",
      secret: "super-secret-openrouter",
      commandId: randomUUID(),
    });
    db.prepare(
      "INSERT INTO folders(id,owner_id,name,kind,created_at) VALUES('foreign-provider-project','other-owner','Foreign','project',0)",
    ).run();
    assert.equal(
      (await request(base("pi") + "?projectId=" + projectId, undefined, false))
        .status,
      401,
    );
    assert.equal(
      (await request(base("pi") + "/key", key("pi"), true, false)).status,
      403,
    );
    assert.equal(
      (
        await request(base("pi") + "/key", {
          ...key("pi"),
          projectId: "foreign-provider-project",
        })
      ).status,
      404,
    );
    assert.equal(
      (await request(base("pi") + "?projectId=foreign-provider-project"))
        .status,
      404,
    );
    // An active run on the same harness blocks a native credential mutation
    // before dispatch. Runs on other harnesses stay active throughout the
    // credential changes below without blocking them.
    for (const harness of ["pi", "codex"])
      db.prepare(
        "INSERT INTO connections(id,owner_id,provider,label,secret,status,models,metadata,created_at) VALUES(?,'local-workspace',?,?,'','connected','[]',?,0)",
      ).run(
        "provider-run-" + harness,
        harness,
        harness,
        JSON.stringify({ loopHarness: harness }),
      );
    const activeRun = db.prepare(
      "INSERT INTO runs(id,owner_id,input,state,idempotency_key,payload,created_at,updated_at) VALUES(?,'local-workspace','','running',?,?,0,0)",
    );
    activeRun.run(
      "provider-active",
      "provider-active",
      JSON.stringify({ connectionId: "provider-run-pi" }),
    );
    const refused = await request(base("pi") + "/key", key("pi"));
    assert.equal(refused.status, 409);
    assert.match(JSON.stringify(await refused.json()), /active Pi runs/);
    db.prepare("DELETE FROM runs WHERE id='provider-active'").run();
    activeRun.run(
      "provider-other-harness",
      "provider-other-harness",
      JSON.stringify({ connectionId: "provider-run-codex" }),
    );
    assert.equal(
      (
        await request(base("pi") + "/key", {
          ...key("pi"),
          secret: "!touch /tmp/unsafe",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(base("pi") + "/key", {
          ...key("pi"),
          executable: "/bin/sh",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(base("codex") + "/key", key("pi"))).status,
      400,
    );
    for (const name of ["pi", "opencode"]) {
      const view = await api(base(name) + "?projectId=" + projectId);
      assert.deepEqual(
        view.providers.map((p: { name: string }) => p.name),
        ["Anthropic", "OpenAI", "OpenRouter"],
      );
      assert.equal(view.enabled, false);
      assert.deepEqual(view.models, []);
    }
    // Pi's existing Claude login is discovered and its explicit subscription
    // restriction survives adding another provider's API key.
    await writeFile(
      join(dir, "pi-auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", key: "oauth-secret" } }),
    );
    await api("/workspace/runtimes/pi/enable", {
      projectId,
      billing: "subscription",
      commandId: randomUUID(),
    });
    const piKey = key("pi");
    const restricted = await api(base("pi") + "/key", piKey);
    assert.equal(restricted.billing, "subscription");
    assert(
      restricted.providers.some(
        (p: any) => p.id === "anthropic" && p.credentialType === "oauth",
      ),
    );
    assert(!restricted.models.some((m: any) => m.id.startsWith("openrouter/")));
    assert(
      !(await api(base("pi") + "?projectId=" + projectId)).models.some(
        (m: any) => m.id.startsWith("openrouter/"),
      ),
    );
    const piView = await api(base("pi") + "/refresh", {
      projectId,
      useProviderBilling: true,
      commandId: randomUUID(),
    });
    assert.equal(piView.billing, "existing");
    assert(piView.models.some((m: any) => m.id === "openrouter/vendor/model"));
    await writeFile(join(dir, "pi-startup-question"), "yes");
    const blocked = await api(base("pi") + "/refresh", {
      projectId,
      commandId: randomUUID(),
    });
    assert.equal(blocked.enabled, false);
    assert.match(blocked.syncError, /asked a question while Pi was starting/);
    assert.doesNotMatch(blocked.syncError, /fixture integration/);
    await rm(join(dir, "pi-startup-question"));
    assert(
      (
        await api(base("pi") + "/refresh", {
          projectId,
          commandId: randomUUID(),
        })
      ).enabled,
    );
    assert(piView.models.some((m: any) => m.id === "anthropic/model"));
    assert.equal(
      (
        await request("/workspace/runtimes/pi/auth/start", {
          projectId,
          provider: "unknown-provider",
          method: "oauth",
          commandId: randomUUID(),
        })
      ).status,
      422,
    );
    const afterRejectedSelection = await api(
      base("pi") + "?projectId=" + projectId,
    );
    assert.equal(afterRejectedSelection.enabled, true);
    assert(
      afterRejectedSelection.models.some(
        (m: any) => m.id === "openrouter/vendor/model",
      ),
    );
    await api(base("pi") + "/key", {
      ...key("pi", "openai"),
      secret: "super-secret-$TOKEN",
    });
    assert.equal(
      JSON.parse(await readFile(join(dir, "pi-auth.json"), "utf8")).openai.key,
      "super-secret-$$TOKEN",
    );
    // First-time uncertain writes also leave a durable disconnected marker, so
    // ordinary startup discovery cannot silently enable the new credential.
    await writeFile(join(dir, "lose-opencode-reply"), "yes");
    assert.equal(
      (await request(base("opencode") + "/key", key("opencode", "openai")))
        .status,
      409,
    );
    await rm(join(dir, "lose-opencode-reply"));
    const { prepareLocalHarnesses } =
      await import("../src/server/local-harnesses.js");
    await prepareLocalHarnesses(dir, ["opencode"]);
    assert.equal(
      (await api(base("opencode") + "?projectId=" + projectId)).enabled,
      false,
    );
    const ocKey = key("opencode");
    const ocView = await api(base("opencode") + "/key", ocKey);
    assert.equal(ocView.enabled, true);
    assert(ocView.models.some((m: any) => m.id === "openrouter/vendor/model"));
    await api(base("opencode") + "/key", ocKey);
    // A prior authority's secret-bearing receipt cannot be replayed, even when
    // a current in-memory result happens to exist for that command ID.
    db.prepare(
      "UPDATE execution_commands SET generation=? WHERE command_id=?",
    ).run(randomUUID(), ocKey.commandId);
    assert.equal((await request(base("opencode") + "/key", ocKey)).status, 409);
    assert.equal(
      (await readFile(join(dir, "provider-audit"), "utf8")).split(
        "opencode:save:openrouter",
      ).length - 1,
      1,
    );
    for (const name of ["pi", "opencode"])
      assert.equal(
        JSON.parse(await readFile(join(dir, name + "-auth.json"), "utf8"))
          .openrouter.key,
        "super-secret-openrouter",
      );
    // Independent OpenAI key adds a second provider without replacing OpenRouter.
    const openai = await api(base("opencode") + "/key", {
      ...key("opencode", "openai"),
      secret: "super-secret-openai",
    });
    assert(openai.models.some((m: any) => m.id === "openai/model"));
    assert(openai.models.some((m: any) => m.id === "openrouter/vendor/model"));
    const connection = db
      .prepare("SELECT models FROM connections WHERE id='native-opencode'")
      .get() as { models: string };
    assert(
      JSON.parse(connection.models).some((m: any) => m.id === "openai/model"),
    );
    // Confirmed saves survive both model-probe and earlier discovery failures.
    // Reconciliation and later model refresh never submit the key again.
    for (const failure of [
      "fail-model-refresh",
      "fail-opencode-discovery-after-save",
    ]) {
      await writeFile(join(dir, failure), "yes");
      const command = {
        ...key("opencode", "openai"),
        secret: "super-secret-openai-new",
      };
      const failedRefresh = await api(base("opencode") + "/key", command);
      assert.equal(failedRefresh.enabled, false);
      assert.match(failedRefresh.syncError, /could not refresh/);
      assert.equal(
        JSON.parse(await readFile(join(dir, "opencode-auth.json"), "utf8"))
          .openai.key,
        "super-secret-openai-new",
      );
      const audit = await readFile(join(dir, "provider-audit"), "utf8");
      assert.deepEqual(
        await api(base("opencode") + "/key", command),
        failedRefresh,
      );
      assert.equal(await readFile(join(dir, "provider-audit"), "utf8"), audit);
      await rm(join(dir, failure));
      await rm(join(dir, "fail-opencode-version"), { force: true });
      assert.match(
        (await api(base("opencode") + "?projectId=" + projectId)).syncError,
        /could not refresh/,
      );
      assert.equal(
        (
          await api(base("opencode") + "/refresh", {
            projectId,
            commandId: randomUUID(),
          })
        ).enabled,
        true,
      );
      assert.equal(await readFile(join(dir, "provider-audit"), "utf8"), audit);
    }
    // A lost native reply after persistence is uncertain, not permission to save again.
    await writeFile(join(dir, "lose-opencode-reply"), "yes");
    const uncertain = {
      ...key("opencode", "openai"),
      secret: "super-secret-replacement",
    };
    assert.equal(
      (await request(base("opencode") + "/key", uncertain)).status,
      409,
    );
    await rm(join(dir, "lose-opencode-reply"));
    const saves = (await readFile(join(dir, "provider-audit"), "utf8")).split(
      "opencode:save:openai",
    ).length;
    assert.equal(
      (await request(base("opencode") + "/key", uncertain)).status,
      409,
    );
    assert.equal(
      (await readFile(join(dir, "provider-audit"), "utf8")).split(
        "opencode:save:openai",
      ).length,
      saves,
    );
    assert.equal(
      JSON.parse(await readFile(join(dir, "opencode-auth.json"), "utf8")).openai
        .key,
      "super-secret-replacement",
    );
    assert.equal(
      (await api(base("opencode") + "?projectId=" + projectId)).enabled,
      false,
    );
    // Removing a saved key can reveal environment auth. Keep execution disabled
    // until the user explicitly reviews that source and re-enables the harness.
    await writeFile(
      join(dir, "opencode-environment.json"),
      JSON.stringify({
        openrouter: { type: "api", key: "super-secret-environment" },
      }),
    );
    const removal = {
      projectId,
      provider: "openrouter",
      commandId: randomUUID(),
    };
    const removed = await api(base("opencode") + "/remove", removal);
    assert.equal(removed.enabled, false);
    assert.equal(
      removed.providers.find((p: any) => p.id === "openrouter").source,
      "environment",
    );
    assert.equal(
      removed.providers.find((p: any) => p.id === "openrouter").removable,
      false,
    );
    await api(base("opencode") + "/remove", removal);
    assert.equal(
      (await readFile(join(dir, "provider-audit"), "utf8")).split(
        "opencode:remove:openrouter",
      ).length - 1,
      1,
    );
    assert(
      JSON.parse(await readFile(join(dir, "opencode-auth.json"), "utf8"))
        .openai,
    );
    assert(
      JSON.parse(await readFile(join(dir, "pi-auth.json"), "utf8")).openrouter,
    );
    const enabled = await api(base("opencode") + "/refresh", {
      projectId,
      commandId: randomUUID(),
    });
    assert.equal(enabled.enabled, true);
    // Guided OAuth still runs through the existing sign-in protocol and then
    // updates catalogs without a model prompt.
    const auth = "/workspace/runtimes/pi/auth";
    const start = await api(auth + "/start", {
      projectId,
      provider: "anthropic",
      method: "oauth",
      commandId: randomUUID(),
    });
    await until(async () => !!(await api(auth + "/status")).attempt?.prompt);
    const waiting = await api(auth + "/status");
    assert.equal((await request(base("pi") + "/key", key("pi"))).status, 409);
    // A second client cannot bypass the provider-sign-in hold through the
    // general connection refresh endpoint and publish an old credential's models.
    assert.equal(
      (await request("/connections/native-pi/refresh", {})).status,
      409,
    );
    assert.equal(
      (await api(base("pi") + "?projectId=" + projectId)).enabled,
      false,
    );
    await api(auth + "/input", {
      attemptId: start.attempt.id,
      promptId: waiting.attempt.prompt.id,
      value: "oauth-secret-new",
    });
    await until(
      async () => (await api(auth + "/status")).attempt?.state === "complete",
    );
    // No browser completion callback or explicit refresh request is needed.
    const afterOAuth = await api(base("pi") + "?projectId=" + projectId);
    assert.equal(afterOAuth.enabled, true);
    assert(afterOAuth.models.some((m: any) => m.id === "anthropic/model"));
    // Authentication can succeed while its follow-up model probe fails. A
    // later catalog read must retain the safe error even without a browser
    // callback, then clear it after a successful explicit refresh.
    for (const failure of [
      "fail-pi-model-refresh",
      "fail-pi-discovery-after-save",
    ]) {
      await writeFile(join(dir, failure), "yes");
      const failedSyncStart = await api(auth + "/start", {
        projectId,
        provider: "anthropic",
        method: "oauth",
        commandId: randomUUID(),
      });
      await until(async () => !!(await api(auth + "/status")).attempt?.prompt);
      await api(auth + "/input", {
        attemptId: failedSyncStart.attempt.id,
        promptId: (await api(auth + "/status")).attempt.prompt.id,
        value: "oauth-secret-refreshed",
      });
      await until(
        async () => (await api(auth + "/status")).attempt?.state === "complete",
      );
      await rm(join(dir, failure));
      await rm(join(dir, "fail-pi-version"), { force: true });
      const failedSync = await api(base("pi") + "?projectId=" + projectId);
      assert.equal(failedSync.enabled, false);
      // A process exit reports Loop's Pi setup guidance; discovery stays generic.
      assert.match(
        failedSync.syncError,
        /could not refresh|Pi could not start/,
      );
      const recovered = await api(base("pi") + "/refresh", {
        projectId,
        commandId: randomUUID(),
      });
      assert.equal(recovered.enabled, true);
      assert.equal(recovered.syncError, undefined);
      assert.equal(
        (await api(base("pi") + "?projectId=" + projectId)).syncError,
        undefined,
      );
    }
    await writeFile(
      join(dir, "opencode-config.json"),
      JSON.stringify({
        anthropic: { type: "api", key: "super-secret-config" },
      }),
    );
    const configured = await api(base("opencode") + "?projectId=" + projectId);
    assert.equal(
      configured.providers.find((p: any) => p.id === "anthropic").removable,
      false,
    );
    assert.equal(
      (
        await request(base("opencode") + "/remove", {
          projectId,
          provider: "anthropic",
          commandId: randomUUID(),
        })
      ).status,
      422,
    );
    assert.equal(
      (await api(base("opencode") + "?projectId=" + projectId)).enabled,
      true,
    );
    assert.doesNotMatch(
      await readFile(join(dir, "provider-audit"), "utf8"),
      /UNEXPECTED/,
    );
    db.prepare("DELETE FROM runs WHERE id='provider-other-harness'").run();
    for (const table of [
      "connections",
      "harnesses",
      "messages",
      "events",
      "execution_commands",
    ])
      assert.doesNotMatch(
        JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),
        /super-secret|oauth-secret|fixture-private/,
      );
  } finally {
    await host.close();
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
