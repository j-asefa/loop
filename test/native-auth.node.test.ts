import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "./helpers.js";
import type { AuthDriver, AuthInteraction } from "../src/server/native-auth.js";
await mkdir(".tmp", { recursive: true });
const dir = await mkdtemp(resolve(".tmp/native-auth-test-"));
process.env.LOOP_DATA_DIR = dir;
process.env.LOOP_PROFILE = "companion";
const { NativeSignIns } = await import("../src/server/native-auth.js");
const { db } = await import("../src/server/db.js");
const { createAuthDriver, setGeminiSignInScreenWait } = await import("../src/native-auth/drivers.js");
after(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
const options = { name: "pi", executable: "fixture", project: dir };
const providers = [
  {
    id: "provider",
    name: "Provider",
    methods: [
      { id: "oauth", type: "oauth" as const, label: "Browser sign-in" },
    ],
  },
];
function mock(
  login: AuthDriver["login"],
  dispose: AuthDriver["dispose"] = async () => {},
) {
  return new NativeSignIns(async () => ({
    providers: async () => providers,
    login,
    dispose,
  }));
}

test("sign-in resumes, accepts each prompt once, suppresses credentials and rejects reused or overlapping commands", async () => {
  let count = 0,
    received = "",
    disposed = 0;
  const auth = mock(
    async (_p, _m, io) => {
      count++;
      io.link("https://provider.example/auth", "ABCD");
      received = await io.prompt({ type: "secret", message: "Enter key" });
    },
    async () => {
      disposed++;
    },
  );
  try {
    const command = randomUUID();
    const started = await auth.start(options, "provider", "oauth", command);
    await until(() => !!auth.status("pi").attempt?.prompt);
    const prompt = auth.status("pi").attempt!.prompt!;
    assert.equal(
      (await auth.catalog(options)).attempt?.id,
      started.attempt?.id,
    );
    assert.equal(
      (await auth.start(options, "provider", "oauth", command)).attempt?.id,
      started.attempt?.id,
    );
    await assert.rejects(
      auth.start(options, "provider", "oauth", randomUUID()),
      /in progress/,
    );
    await assert.rejects(
      auth.start(
        { ...options, project: dir + "/other" },
        "provider",
        "oauth",
        randomUUID(),
      ),
      /changing/,
    );
    assert.equal(count, 1);
    assert.throws(
      () =>
        auth.answer("pi", started.attempt!.id, randomUUID(), "secret-value"),
      /ended/,
    );
    const answered = auth.answer(
      "pi",
      started.attempt!.id,
      prompt.id,
      "secret-value",
    );
    assert.doesNotMatch(JSON.stringify(answered), /secret-value/);
    assert.throws(
      () => auth.answer("pi", started.attempt!.id, prompt.id, "secret-value"),
      /ended/,
    );
    await until(() => auth.status("pi").attempt?.state === "complete");
    assert.equal(received, "secret-value");
    assert.equal(disposed, 1);
    assert.equal(auth.status("pi").attempt?.url, undefined);
    assert.equal(auth.status("pi").attempt?.code, undefined);
    await auth.start(options, "provider", "oauth", randomUUID());
    await assert.rejects(
      auth.start(options, "provider", "oauth", command),
      /already been used/,
    );
  } finally {
    await auth.close();
  }
});

test("cancellation and expiry abort prompts and preserve terminal state without replay", async () => {
  let aborted = 0;
  const driver = async (): Promise<AuthDriver> => ({
    providers: async () => providers,
    login: async (_p, _m, io) => {
      io.signal.addEventListener("abort", () => aborted++);
      await io.prompt({ type: "text", message: "Code" });
    },
    dispose: async () => {},
  });
  const auth = new NativeSignIns(driver, 80);
  try {
    const first = await auth.start(options, "provider", "oauth", randomUUID());
    await until(() => !!auth.status("pi").attempt?.prompt);
    await auth.cancel("pi", first.attempt!.id);
    assert.equal(auth.status("pi").attempt?.state, "cancelled");
    const command = randomUUID();
    await auth.start(options, "provider", "oauth", command);
    await until(() => auth.status("pi").attempt?.state === "expired");
    assert.equal(
      (await auth.start(options, "provider", "oauth", command)).attempt?.state,
      "expired",
    );
    assert.equal(aborted, 2);
  } finally {
    await auth.close();
  }
});

test("failed setup and invalid authorization URLs never leak provider diagnostics", async () => {
  const broken = new NativeSignIns(async () => {
    throw new Error("private-token");
  });
  await assert.rejects(
    broken.catalog(options),
    (error: Error) =>
      !error.message.includes("private-token") &&
      error.message.includes("Could not load"),
  );
  for (const url of [
    "javascript:alert(1)",
    "https://user:secret@example.com/login",
    "http://provider.example/login",
  ]) {
    const auth = mock(async (_p, _m, io) => io.link(url));
    try {
      await auth.start(options, "provider", "oauth", randomUUID());
      await until(() => auth.status("pi").attempt?.state === "failed");
      assert.equal(auth.status("pi").attempt?.url, undefined);
    } finally {
      await auth.close();
    }
  }
});

test("out-of-band completion clears an obsolete prompt and selects validate their values", async () => {
  let clear: AbortController;
  let answer = "";
  const auth = mock(async (_p, _m, io) => {
    clear = new AbortController();
    await io
      .prompt({ type: "manual_code", message: "Code" }, clear.signal)
      .catch(() => {});
    answer = await io.prompt({
      type: "select",
      message: "Account",
      options: [{ id: "personal", label: "Personal" }],
    });
  });
  try {
    await auth.start(options, "provider", "oauth", randomUUID());
    await until(() => !!auth.status("pi").attempt?.prompt);
    const first = auth.status("pi").attempt!;
    clear!.abort();
    await until(() => auth.status("pi").attempt?.prompt?.type === "select");
    const second = auth.status("pi").attempt!;
    assert.throws(
      () => auth.answer("pi", first.id, first.prompt!.id, "old-code"),
      /ended/,
    );
    assert.throws(
      () => auth.answer("pi", second.id, second.prompt!.id, "invalid"),
      /available options/,
    );
    auth.answer("pi", second.id, second.prompt!.id, "personal");
    await until(() => auth.status("pi").attempt?.state === "complete");
    assert.equal(answer, "personal");
  } finally {
    await auth.close();
  }
});

for (const name of ["codex", "claude", "pi", "opencode", "gemini", "muse", "grok"]) {
  test(`${name}: native sign-in protocol and credential storage without any model session`, async () => {
    const project = join(dir, name);
    await mkdir(project);
    const executable = join(project, name);
    await writeFile(
      executable,
      `#!/bin/sh\nexport LOOP_TEST_HARNESS=${name}\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
      { mode: 0o755 },
    );
    const auth = new NativeSignIns(createAuthDriver);
    const opts = {
      name, executable, project,
      env: { HOME: project, LOOP_TEST_CLEAN_ENV: "1" },
    };
    const priorHostOnly = process.env.LOOP_TEST_HOST_ONLY;
    process.env.LOOP_TEST_HOST_ONLY = "must-not-reach-runner";
    try {
      const catalog = await auth.catalog(opts);
      assert.doesNotMatch(JSON.stringify(catalog), /fixture-private/);
      const provider = catalog.providers[0];
      const command = randomUUID();
      await auth.start(opts, provider.id, provider.methods[0].id, command);
      await until(() => !!auth.status(name).attempt?.url);
      if (name === "codex")
        assert.equal(auth.status(name).attempt?.code, "ABCD-12345");
      if (name === "muse")
        assert.equal(auth.status(name).attempt?.code, "FIXT-CODE");
      if (name === "grok") {
        assert.equal(auth.status(name).attempt?.code, "KSXH-JR4E");
        assert.equal(
          new URL(auth.status(name).attempt!.url!).hostname,
          "accounts.x.ai",
        );
      }
      if (name === "opencode")
        assert.match(
          auth.status(name).attempt?.instructions || "",
          /1234-5678/,
        );
      if (["codex", "opencode", "muse", "grok"].includes(name))
        await writeFile(join(project, "authorize-" + name), "yes");
      else {
        await until(() => !!auth.status(name).attempt?.prompt);
        const attempt = auth.status(name).attempt!;
        auth.answer(name, attempt.id, attempt.prompt!.id, "fixture-code");
      }
      await until(() => auth.status(name).attempt?.state === "complete");
      assert.equal(
        (await auth.start(opts, provider.id, provider.methods[0].id, command))
          .attempt?.state,
        "complete",
      );
      const stored = JSON.parse(
        await readFile(join(project, name + "-credential.json"), "utf8"),
      );
      assert.equal(stored.method, "oauth");
      assert.doesNotMatch(
        JSON.stringify(auth.status(name)),
        /fixture-code|fixture-token|fixture-private/,
      );
      const audit = await readFile(join(project, "auth-audit"), "utf8");
      assert.doesNotMatch(audit, /\/session|prompt/);
      if (name === "gemini") assert.match(audit, /gemini:authenticate/);
    } finally {
      await auth.close();
      if (priorHostOnly === undefined) delete process.env.LOOP_TEST_HOST_ONLY;
      else process.env.LOOP_TEST_HOST_ONLY = priorHostOnly;
    }
  });
}

test("Pi rejects invalid prompts and lets the next sign-in start", async () => {
  const project = join(dir, "pi-bad-prompt");
  await mkdir(project);
  const executable = join(project, "pi");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=pi\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "pi", executable, project };
  process.env.LOOP_TEST_PI_BAD_PROMPT = "1";
  try {
    const catalog = await auth.catalog(opts);
    await auth.start(opts, catalog.providers[0].id, "oauth", randomUUID());
    await until(() => auth.status("pi").attempt?.state === "failed");
    delete process.env.LOOP_TEST_PI_BAD_PROMPT;
    await auth.start(opts, catalog.providers[0].id, "oauth", randomUUID());
    await until(() => !!auth.status("pi").attempt?.prompt);
    const attempt = auth.status("pi").attempt!;
    auth.answer("pi", attempt.id, attempt.prompt!.id, "fixture-code");
    await until(() => auth.status("pi").attempt?.state === "complete");
  } finally {
    delete process.env.LOOP_TEST_PI_BAD_PROMPT;
    await auth.close();
  }
});

test("Gemini ends a sign-in on a rejected code without authenticating or relaying a second URL", async () => {
  const project = join(dir, "gemini-bad-code");
  await mkdir(project);
  const executable = join(project, "gemini");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=gemini\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "gemini", executable, project, env: { ...process.env, HOME: project } };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => !!auth.status("gemini").attempt?.prompt);
    const attempt = auth.status("gemini").attempt!;
    assert.equal(new URL(attempt.url!).hostname, "accounts.google.com");
    auth.answer("gemini", attempt.id, attempt.prompt!.id, "wrong-code");
    await until(() => auth.status("gemini").attempt?.state === "failed");
    assert.ok(!existsSync(join(project, "gemini-credential.json")));
    const audit = await readFile(join(project, "auth-audit"), "utf8");
    assert.doesNotMatch(audit, /authenticate/);
  } finally {
    await auth.close();
  }
});

test("Muse stores an API key through its own account API and signs out", async () => {
  const project = join(dir, "muse-api");
  await mkdir(project);
  const executable = join(project, "muse");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=muse\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  // Real Muse 1.4.12 also notifies completion; the account state alone must
  // confirm the key.
  const driver = await createAuthDriver({
    name: "muse",
    executable,
    project,
    env: { ...process.env, LOOP_TEST_AUTH_DIR: project, LOOP_TEST_MUSE_SILENT_KEY: "1" },
  });
  try {
    assert.equal((await driver.providers())[0].configured, false);
    const prompts: string[] = [];
    await driver.login("meta", "api", {
      signal: new AbortController().signal,
      link() {
        assert.fail("An API key needs no link");
      },
      async prompt(prompt) {
        prompts.push(prompt.type);
        return "fixture-super-private-provider-key";
      },
    });
    assert.deepEqual(prompts, ["secret"]);
    assert.equal(
      JSON.parse(await readFile(join(project, "muse-credential.json"), "utf8")).key,
      "fixture-super-private-provider-key",
    );
    assert.equal((await driver.providers())[0].configured, true);
    await driver.logout!("meta");
    assert.equal((await driver.providers())[0].configured, false);
  } finally {
    await driver.dispose();
  }
});

test("Gemini with cached Google credentials completes without a code", async () => {
  const project = join(dir, "gemini-cached");
  await mkdir(project);
  const executable = join(project, "gemini");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=gemini\nexport LOOP_TEST_GEMINI_CACHED=1\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  setGeminiSignInScreenWait(200);
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "gemini", executable, project, env: { ...process.env, HOME: project } };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => auth.status("gemini").attempt?.state === "complete");
    assert.equal(auth.status("gemini").attempt?.prompt, undefined);
    assert.match(await readFile(join(project, "auth-audit"), "utf8"), /gemini:authenticate/);
  } finally {
    setGeminiSignInScreenWait(15000);
    await auth.close();
  }
});

test("Gemini relays the fresh URL when its sign-in screen opens after the cached-credential wait", async () => {
  const project = join(dir, "gemini-slow");
  await mkdir(project);
  const executable = join(project, "gemini");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=gemini\nexport LOOP_TEST_GEMINI_DELAY_MS=500\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  setGeminiSignInScreenWait(100);
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "gemini", executable, project, env: { ...process.env, HOME: project } };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    // Gemini read Loop's initialize frame as a bad code and asked again.
    await until(() => !!auth.status("gemini").attempt?.prompt);
    const attempt = auth.status("gemini").attempt!;
    assert.equal(new URL(attempt.url!).hostname, "accounts.google.com");
    auth.answer("gemini", attempt.id, attempt.prompt!.id, "fixture-code");
    await until(() => auth.status("gemini").attempt?.state === "complete");
    assert.match(await readFile(join(project, "auth-audit"), "utf8"), /gemini:authenticate/);
  } finally {
    setGeminiSignInScreenWait(15000);
    await auth.close();
  }
});

test("Gemini refuses an authorization URL carrying credentials without crashing", async () => {
  const project = join(dir, "gemini-userinfo");
  await mkdir(project);
  const executable = join(project, "gemini");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=gemini\nexport LOOP_TEST_GEMINI_URL='https://x@accounts.google.com/o/oauth2/v2/auth'\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "gemini", executable, project, env: { ...process.env, HOME: project } };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => auth.status("gemini").attempt?.state === "failed");
    assert.equal(auth.status("gemini").attempt?.url, undefined);
  } finally {
    await auth.close();
  }
});

test("Pi restarts an auth process that exited while idle", async () => {
  const project = join(dir, "pi-idle-exit");
  await mkdir(project);
  const executable = join(project, "pi");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP_TEST_HARNESS=pi\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "pi", executable, project };
  process.env.LOOP_TEST_PI_EXIT_IDLE = "1";
  try {
    const catalog = await auth.catalog(opts);
    await until(() => existsSync(join(project, "pi-exited-once")));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await auth.start(opts, catalog.providers[0].id, "oauth", randomUUID());
    await until(() => !!auth.status("pi").attempt?.prompt);
    const attempt = auth.status("pi").attempt!;
    auth.answer("pi", attempt.id, attempt.prompt!.id, "fixture-code");
    await until(() => auth.status("pi").attempt?.state === "complete");
  } finally {
    delete process.env.LOOP_TEST_PI_EXIT_IDLE;
    await auth.close();
  }
});

for (const method of ["1", "2"]) {
  test(`OpenCode ${method === "1" ? "verification-code prompts" : "API-key storage"} uses native provider auth endpoints`, async () => {
    const project = join(dir, "opencode-" + method);
    await mkdir(project);
    const executable = join(project, "opencode");
    await writeFile(
      executable,
      `#!/bin/sh\nexport LOOP_TEST_HARNESS=opencode\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
      { mode: 0o755 },
    );
    const auth = new NativeSignIns(createAuthDriver);
    try {
      await auth.start(
        { name: "opencode", executable, project },
        "openai",
        method,
        randomUUID(),
      );
      await until(() => !!auth.status("opencode").attempt?.prompt);
      const first = auth.status("opencode").attempt!;
      if (method === "1") {
        assert.equal(first.prompt?.type, "select");
        auth.answer("opencode", first.id, first.prompt!.id, "global");
        await until(
          () => auth.status("opencode").attempt?.prompt?.type === "manual_code",
        );
        const code = auth.status("opencode").attempt!;
        // The custom-domain question must be skipped by the provider's `when` condition.
        assert.match(code.prompt!.message, /verification code/);
        auth.answer("opencode", code.id, code.prompt!.id, "fixture-code");
      } else {
        assert.equal(first.prompt?.type, "secret");
        auth.answer(
          "opencode",
          first.id,
          first.prompt!.id,
          "fixture-private-api-key",
        );
      }
      await until(() => auth.status("opencode").attempt?.state === "complete");
      const credential = JSON.parse(
        await readFile(join(project, "opencode-credential.json"), "utf8"),
      );
      assert.equal(credential.method, method === "1" ? "oauth" : "api");
      assert.doesNotMatch(
        JSON.stringify(auth.status("opencode")),
        /fixture-private-api-key/,
      );
    } finally {
      await auth.close();
    }
  });
}
