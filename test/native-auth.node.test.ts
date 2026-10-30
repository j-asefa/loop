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
process.env.LOOP55_DATA_DIR = dir;
process.env.LOOP55_PROFILE = "companion";
const { NativeSignIns } = await import("../src/server/native-auth.js");
const { db } = await import("../src/server/db.js");
const {
  createAuthDriver,
  setAntigravityExchangeWait,
  setAntigravityStartWait,
  setGeminiSignInScreenWait,
} = await import("../src/native-auth/drivers.js");
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

for (const name of [
  "codex",
  "claude",
  "pi",
  "opencode",
  "gemini",
  "muse",
  "grok",
]) {
  test(`${name}: native sign-in protocol and credential storage without any model session`, async () => {
    const project = join(dir, name);
    await mkdir(project);
    const executable = join(project, name);
    await writeFile(
      executable,
      `#!/bin/sh\nexport LOOP55_TEST_HARNESS=${name}\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
      { mode: 0o755 },
    );
    const auth = new NativeSignIns(createAuthDriver);
    const opts = {
      name,
      executable,
      project,
      env: { HOME: project, LOOP55_TEST_CLEAN_ENV: "1" },
    };
    const priorHostOnly = process.env.LOOP55_TEST_HOST_ONLY;
    process.env.LOOP55_TEST_HOST_ONLY = "must-not-reach-runner";
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
      if (priorHostOnly === undefined) delete process.env.LOOP55_TEST_HOST_ONLY;
      else process.env.LOOP55_TEST_HOST_ONLY = priorHostOnly;
    }
  });
}

test("Pi rejects invalid prompts and lets the next sign-in start", async () => {
  const project = join(dir, "pi-bad-prompt");
  await mkdir(project);
  const executable = join(project, "pi");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=pi\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "pi", executable, project };
  process.env.LOOP55_TEST_PI_BAD_PROMPT = "1";
  try {
    const catalog = await auth.catalog(opts);
    await auth.start(opts, catalog.providers[0].id, "oauth", randomUUID());
    await until(() => auth.status("pi").attempt?.state === "failed");
    delete process.env.LOOP55_TEST_PI_BAD_PROMPT;
    await auth.start(opts, catalog.providers[0].id, "oauth", randomUUID());
    await until(() => !!auth.status("pi").attempt?.prompt);
    const attempt = auth.status("pi").attempt!;
    auth.answer("pi", attempt.id, attempt.prompt!.id, "fixture-code");
    await until(() => auth.status("pi").attempt?.state === "complete");
  } finally {
    delete process.env.LOOP55_TEST_PI_BAD_PROMPT;
    await auth.close();
  }
});

test("Gemini ends a sign-in on a rejected code without authenticating or relaying a second URL", async () => {
  const project = join(dir, "gemini-bad-code");
  await mkdir(project);
  const executable = join(project, "gemini");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=gemini\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = {
    name: "gemini",
    executable,
    project,
    env: { ...process.env, HOME: project },
  };
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
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => !!auth.status("gemini").attempt?.prompt);
    const retry = auth.status("gemini").attempt!;
    assert.notEqual(retry.id, attempt.id);
    assert.notEqual(retry.url, attempt.url);
    auth.answer("gemini", retry.id, retry.prompt!.id, "fixture-code");
    await until(() => auth.status("gemini").attempt?.state === "complete");
  } finally {
    await auth.close();
  }
});

for (const failure of ["retired", "retired-stderr", "unknown"]) {
  test(`Gemini ${failure} rejection survives cached-login retry without exposing provider output`, async () => {
    const project = join(dir, `gemini-rejection-${failure}`);
    await mkdir(project);
    const executable = join(project, "gemini");
    await writeFile(
      executable,
      `#!/bin/sh\nexport LOOP55_TEST_HARNESS=gemini\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
      { mode: 0o755 },
    );
    const auth = new NativeSignIns(createAuthDriver);
    const opts = {
      name: "gemini",
      executable,
      project,
      env: {
        ...process.env,
        HOME: project,
        LOOP55_TEST_GEMINI_AUTH_FAILURE: failure,
      },
    };
    setGeminiSignInScreenWait(200);
    try {
      await auth.start(opts, "google", "oauth", randomUUID());
      await until(() => !!auth.status("gemini").attempt?.prompt);
      const first = auth.status("gemini").attempt!;
      auth.answer("gemini", first.id, first.prompt!.id, "fixture-code");
      await until(() => auth.status("gemini").attempt?.state === "failed");
      assert(existsSync(join(project, "gemini-credential.json")));
      const checkFailure = () => {
        const result = auth.status("gemini");
        assert.equal(
          result.attempt?.failureCode,
          failure.startsWith("retired")
            ? "gemini_google_sign_in_retired"
            : undefined,
        );
        assert.equal(result.attempt?.url, undefined);
        assert.equal(result.attempt?.prompt, undefined);
        assert.doesNotMatch(
          JSON.stringify(result),
          /fixture-private|fixture-code|fixture-token/,
        );
      };
      checkFailure();
      // Google saved the credential before rejecting access. A fresh process
      // skips the browser exchange, but must preserve the same safe reason.
      await auth.start(opts, "google", "oauth", randomUUID());
      assert.notEqual(auth.status("gemini").attempt?.id, first.id);
      await until(() => auth.status("gemini").attempt?.state === "failed");
      checkFailure();
    } finally {
      setGeminiSignInScreenWait(15000);
      await auth.close();
    }
  });
}

test("Antigravity signs in through agy's terminal sign-in and confirms with agy models", async () => {
  const project = join(dir, "antigravity-sign-in");
  await mkdir(project);
  const executable = join(project, "agy");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=antigravity\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  setAntigravityExchangeWait(5000);
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "antigravity", executable, project };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => !!auth.status("antigravity").attempt?.prompt);
    const attempt = auth.status("antigravity").attempt!;
    const url = new URL(attempt.url!);
    assert.equal(url.hostname, "accounts.google.com");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://antigravity.google/oauth-callback",
    );
    assert.equal(attempt.prompt!.type, "manual_code");
    auth.answer("antigravity", attempt.id, attempt.prompt!.id, "wrong-code");
    await until(() => auth.status("antigravity").attempt?.state === "failed");
    assert.ok(!existsSync(join(project, "antigravity-credential.json")));
    assert.doesNotMatch(
      JSON.stringify(auth.status("antigravity")),
      /fixture-private|invalid_grant/,
    );

    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => !!auth.status("antigravity").attempt?.prompt);
    const retry = auth.status("antigravity").attempt!;
    assert.notEqual(retry.url, attempt.url);
    // Terminal controls are removed before the code reaches agy's input.
    auth.answer(
      "antigravity",
      retry.id,
      retry.prompt!.id,
      "\u0007 fixture-code\u007f\u0003\n",
    );
    await until(
      () => auth.status("antigravity").attempt?.state === "complete",
      15000,
    );
    assert.ok(existsSync(join(project, "antigravity-credential.json")));

    // Already signed in: agy models succeeds and no terminal sign-in starts.
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(
      () => auth.status("antigravity").attempt?.state === "complete",
      15000,
    );
    const audit = await readFile(join(project, "auth-audit"), "utf8");
    assert.equal(audit.match(/antigravity:login/g)?.length, 2);
  } finally {
    await auth.close();
    setAntigravityExchangeWait(90000);
  }
});

test("Antigravity completes when agy exits after saving its credential", async () => {
  const project = join(dir, "antigravity-exit");
  await mkdir(project);
  const executable = join(project, "agy");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=antigravity\nexport LOOP55_TEST_AGY_EXIT_AFTER_SIGN_IN=1\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "antigravity", executable, project };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => !!auth.status("antigravity").attempt?.prompt);
    const attempt = auth.status("antigravity").attempt!;
    auth.answer("antigravity", attempt.id, attempt.prompt!.id, "fixture-code");
    await until(
      () => auth.status("antigravity").attempt?.state === "complete",
      15000,
    );
  } finally {
    await auth.close();
  }
});

test("Cancelling Antigravity during its account check stops every check", async () => {
  const project = join(dir, "antigravity-cancel");
  await mkdir(project);
  const executable = join(project, "agy");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=antigravity\nexport LOOP55_TEST_AGY_SLOW_MODELS=1\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const pids = async (file = "models-pids") =>
    (await readFile(join(project, file), "utf8"))
      .trim()
      .split("\n")
      .map(Number);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "antigravity", executable, project };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => !!auth.status("antigravity").attempt?.prompt);
    const attempt = auth.status("antigravity").attempt!;
    auth.answer("antigravity", attempt.id, attempt.prompt!.id, "fixture-code");
    // The pre-check plus the slow post-exchange check.
    await until(async () => (await pids()).length >= 2);
    await auth.cancel("antigravity", attempt.id);
    assert.equal(auth.status("antigravity").attempt?.state, "cancelled");
    await until(async () => !(await pids()).some(alive), 5000);
    // The terminal sign-in ends with it.
    await until(async () => !(await pids("login-pids")).some(alive), 5000);
    const started = (await pids()).length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal((await pids()).length, started);
  } finally {
    await auth.close();
  }
});

test("Antigravity ends a sign-in whose terminal never shows its link", async () => {
  const project = join(dir, "antigravity-stall");
  await mkdir(project);
  const executable = join(project, "agy");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=antigravity\nexport LOOP55_TEST_AGY_STALL=1\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  setAntigravityStartWait(1000);
  const auth = new NativeSignIns(createAuthDriver);
  try {
    await auth.start(
      { name: "antigravity", executable, project },
      "google",
      "oauth",
      randomUUID(),
    );
    await until(
      () => auth.status("antigravity").attempt?.state === "failed",
      10000,
    );
    const [pid] = (await readFile(join(project, "login-pids"), "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
  } finally {
    await auth.close();
    setAntigravityStartWait(30000);
  }
});

test("Muse stores an API key through its own account API and signs out", async () => {
  const project = join(dir, "muse-api");
  await mkdir(project);
  const executable = join(project, "muse");
  await writeFile(
    executable,
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=muse\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  // Real Muse 1.4.12 also notifies completion; the account state alone must
  // confirm the key.
  const driver = await createAuthDriver({
    name: "muse",
    executable,
    project,
    env: {
      ...process.env,
      LOOP55_TEST_AUTH_DIR: project,
      LOOP55_TEST_MUSE_SILENT_KEY: "1",
    },
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
      JSON.parse(await readFile(join(project, "muse-credential.json"), "utf8"))
        .key,
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
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=gemini\nexport LOOP55_TEST_GEMINI_CACHED=1\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  setGeminiSignInScreenWait(200);
  const auth = new NativeSignIns(createAuthDriver);
  const opts = {
    name: "gemini",
    executable,
    project,
    env: { ...process.env, HOME: project },
  };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    await until(() => auth.status("gemini").attempt?.state === "complete");
    assert.equal(auth.status("gemini").attempt?.prompt, undefined);
    assert.match(
      await readFile(join(project, "auth-audit"), "utf8"),
      /gemini:authenticate/,
    );
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
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=gemini\nexport LOOP55_TEST_GEMINI_DELAY_MS=500\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  setGeminiSignInScreenWait(100);
  const auth = new NativeSignIns(createAuthDriver);
  const opts = {
    name: "gemini",
    executable,
    project,
    env: { ...process.env, HOME: project },
  };
  try {
    await auth.start(opts, "google", "oauth", randomUUID());
    // Gemini read Loop55's initialize frame as a bad code and asked again.
    await until(() => !!auth.status("gemini").attempt?.prompt);
    const attempt = auth.status("gemini").attempt!;
    assert.equal(new URL(attempt.url!).hostname, "accounts.google.com");
    auth.answer("gemini", attempt.id, attempt.prompt!.id, "fixture-code");
    await until(() => auth.status("gemini").attempt?.state === "complete");
    assert.match(
      await readFile(join(project, "auth-audit"), "utf8"),
      /gemini:authenticate/,
    );
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
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=gemini\nexport LOOP55_TEST_GEMINI_URL='https://x@accounts.google.com/o/oauth2/v2/auth'\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = {
    name: "gemini",
    executable,
    project,
    env: { ...process.env, HOME: project },
  };
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
    `#!/bin/sh\nexport LOOP55_TEST_HARNESS=pi\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  const auth = new NativeSignIns(createAuthDriver);
  const opts = { name: "pi", executable, project };
  process.env.LOOP55_TEST_PI_EXIT_IDLE = "1";
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
    delete process.env.LOOP55_TEST_PI_EXIT_IDLE;
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
      `#!/bin/sh\nexport LOOP55_TEST_HARNESS=opencode\nexec '${process.execPath}' '${resolve("test/auth-harness.mjs")}' "$@"\n`,
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
