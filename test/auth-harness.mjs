#!/usr/bin/env node
// Sign-in protocol fixture: no provider traffic or model inference.
import { createServer } from "node:http";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
const kind = process.env.LOOP_TEST_HARNESS;
if (
  process.env.LOOP_TEST_CLEAN_ENV === "1" &&
  (process.env.LOOP_TEST_HOST_ONLY ||
    process.env.LOOP_PROFILE ||
    process.env.LOOP_DB ||
    process.env.PROVIDER_FIXTURE_TOKEN !== "fixture-provider-token" ||
    process.env.HOME !== process.cwd())
) {
  process.exit(91);
}
const path = process.env.LOOP_TEST_AUTH_DIR || process.cwd();
const credential = path + "/" + kind + "-credential.json";
const finish = path + "/authorize-" + kind;
const save = (method, key = "fixture-token-private") =>
  writeFileSync(credential, JSON.stringify({ method, key }), { mode: 0o600 });
const audit = (message) =>
  appendFileSync(path + "/auth-audit", kind + ":" + message + "\n");
if (process.argv.includes("--version")) {
  console.log(
    {
      codex: "0.159.0",
      claude: "2.1.284",
      pi: "0.87.1",
      opencode: "1.18.33",
      muse: "Muse Code 1.4.12 (1.4.12-R6909.1)",
      grok: "grok 1.0.70 (f50904eaee6c)",
    }[kind],
  );
} else if (kind === "antigravity" && process.argv[2] === "models") {
  audit("models");
  appendFileSync(path + "/models-pids", process.pid + "\n");
  // A slow account check after sign-in, for cancellation.
  if (process.env.LOOP_TEST_AGY_SLOW_MODELS && existsSync(credential))
    await new Promise((resolve) => setTimeout(resolve, 60000));
  if (!existsSync(credential)) {
    console.log("Fetching available models...");
    console.error(
      "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
    );
    process.exit(1);
  }
  console.log("fixture-model  Fixture Model");
} else if (kind === "antigravity" && process.argv.length === 2) {
  // agy 1.4.9's terminal sign-in; it refuses to run without a terminal.
  if (!process.stdin.isTTY || process.env.BROWSER !== "false") process.exit(2);
  audit("login");
  appendFileSync(path + "/login-pids", process.pid + "\n");
  // A stalled agy that never shows its sign-in menu.
  if (process.env.LOOP_TEST_AGY_STALL)
    await new Promise((resolve) => setTimeout(resolve, 60000));
  // The menu arrives in chunks, split inside the highlighted choice.
  const menu =
    "\x1b[2J Welcome to the Antigravity CLI. You are currently not signed in.\n\n" +
    " Select login method:\n \x1b[1m> 1. Goo";
  process.stdout.write(menu);
  setTimeout(
    () =>
      process.stdout.write(
        "gle OAuth\x1b[0m\n   2. Use a Google Cloud project\n",
      ),
    50,
  );
  let step = 0;
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (step++ === 0)
      return process.stdout.write(
        " Signing in... Your browser should open automatically. If not:\n\n " +
          `https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=fixture-${process.pid}` +
          "\n\n If you aren't automatically redirected, paste the authorization code below:\n",
      );
    if (line.trim() !== "fixture-code")
      return process.stdout.write(
        ' Got an error: token exchange failed: oauth2: "invalid_grant" fixture-private-detail\n',
      );
    save("oauth");
    process.stdout.write(" Signed in.\n");
    if (process.env.LOOP_TEST_AGY_EXIT_AFTER_SIGN_IN) process.exit(0);
  });
} else if (kind === "codex" && process.argv[2] === "login") {
  audit("login");
  if (!process.argv.includes("--device-auth")) process.exit(1);
  process.stdout.write("Open https://chatgpt.");
  setTimeout(() => process.stdout.write("com/device\nCode: ABCD-12345\n"), 15);
  setInterval(() => {
    if (existsSync(finish)) {
      save("oauth");
      process.exit(0);
    }
  }, 25);
} else if (kind === "grok" && process.argv[2] === "login") {
  // Grok 1.0.70's device-code output, including its ANSI-dimmed warning.
  audit("login");
  if (
    !process.argv.includes("--device-auth") ||
    process.env.BROWSER !== "false" ||
    process.env.GROK_DISABLE_AUTOUPDATER !== "1"
  )
    process.exit(1);
  process.stdout.write(
    "\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=KSXH-JR4E\n\n" +
      "Confirm this code in your browser:\n\n  KSXH-JR4E\n\n" +
      "\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m\n\nWaiting for authorization...\n",
  );
  setInterval(() => {
    if (existsSync(finish)) {
      save("oauth");
      process.exit(0);
    }
  }, 25);
} else if (
  kind === "claude" &&
  process.argv[2] === "auth" &&
  process.argv[3] === "login"
) {
  audit("login");
  console.log(
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=fixture",
  );
  console.log("Paste code here if prompted > ");
  createInterface({ input: process.stdin }).once("line", (value) => {
    if (value !== "fixture-code") {
      console.error("Unfiltered private diagnostic: " + value);
      process.exit(1);
    }
    save(process.argv.includes("--console") ? "api" : "oauth");
    console.log("Login complete");
    process.exit(0);
  });
} else if (
  kind === "pi" &&
  process.argv.some((a) => a.endsWith("/pi-auth-extension.mjs"))
) {
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  if (existsSync(path + "/refuse-auth-providers")) process.exit(1);
  const send = (message) => channel.write(JSON.stringify(message) + "\n");
  let method;
  let provider;
  send({
    type: "providers",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: existsSync(credential),
        methods: [
          { id: "oauth", type: "oauth", label: "Sign in with Claude" },
          { id: "api", type: "api", label: "API key" },
        ],
        credentials: "fixture-private-never-send",
      },
    ],
  });
  if (
    process.env.LOOP_TEST_PI_EXIT_IDLE &&
    !existsSync(path + "/pi-exited-once")
  ) {
    writeFileSync(path + "/pi-exited-once", "yes");
    setTimeout(() => process.exit(0), 100);
  }
  createInterface({ input: channel }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "models") send({ type: "models", models: [] });
    if (message.type === "login") {
      audit("login");
      ({ provider, method } = message);
      if (method === "oauth")
        send({
          type: "link",
          url: "https://claude.com/oauth/authorize?state=pi-fixture",
        });
      send({
        type: "prompt",
        id: "fixture-prompt",
        prompt: {
          type: method === "api" ? "secret" : "manual_code",
          message: process.env.LOOP_TEST_PI_BAD_PROMPT
            ? "x".repeat(600)
            : method === "api"
              ? "Enter your API key"
              : "Paste the provider code",
        },
      });
    }
    if (message.type === "input") {
      if (message.id !== "fixture-prompt") process.exit(1);
      save(method, message.value);
      send({
        type: "complete",
        access_token: "fixture-private-never-send",
        refresh_token: "fixture-private-refresh-token",
        device_code: "fixture-private-polling-token",
        api_key: "fixture-private-api-key",
        credentials: "fixture-private-credential-file",
        provider,
      });
    }
  });
} else if (kind === "muse" && process.argv[2] === "serve") {
  // Muse's account surface is the MSP fixture; credentials stay in `path`.
  audit("login");
  process.env.LOOP_TEST_MUSE_DIR = path;
  await import("./fixtures/fake-muse.mjs");
} else if (kind === "opencode" && process.argv[2] === "serve") {
  const expected =
    "Basic " +
    Buffer.from(
      process.env.OPENCODE_SERVER_USERNAME +
        ":" +
        process.env.OPENCODE_SERVER_PASSWORD,
    ).toString("base64");
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== expected) {
      res.statusCode = 401;
      res.end("{}");
      return;
    }
    audit(req.method + " " + req.url);
    let raw = "";
    for await (const data of req) raw += data;
    const body = raw ? JSON.parse(raw) : {};
    const send = (data) => res.end(JSON.stringify(data));
    if (req.url === "/provider")
      return send({
        all: [{ id: "openai", name: "OpenAI" }],
        connected: existsSync(credential) ? ["openai"] : [],
      });
    if (req.url === "/provider/auth")
      return send({
        openai: [
          { type: "oauth", label: "Device sign-in" },
          {
            type: "oauth",
            label: "Browser code",
            prompts: [
              {
                type: "select",
                key: "region",
                message: "Choose region",
                options: [
                  { value: "global", label: "Global" },
                  { value: "custom", label: "Custom" },
                ],
              },
              {
                type: "text",
                key: "domain",
                message: "Enter domain",
                when: { key: "region", op: "eq", value: "custom" },
              },
            ],
          },
          { type: "api", label: "API key" },
        ],
      });
    if (req.url === "/provider/openai/oauth/authorize")
      return send({
        url: "https://auth.openai.com/fixture",
        method: body.method === 0 ? "auto" : "code",
        instructions:
          body.method === 0
            ? "Enter device code 1234-5678"
            : "Paste your verification code",
      });
    if (req.url === "/provider/openai/oauth/callback") {
      if (body.method === 0) {
        const timer = setInterval(() => {
          if (existsSync(finish)) {
            clearInterval(timer);
            save("oauth");
            send(true);
          }
        }, 25);
        res.on("close", () => clearInterval(timer));
      } else if (body.code === "fixture-code") {
        save("oauth");
        send(true);
      } else {
        res.statusCode = 400;
        send({ error: body.code });
      }
      return;
    }
    if (req.url === "/auth/openai" && req.method === "PUT") {
      save("api", body.key);
      return send(true);
    }
    res.statusCode = 404;
    send({ error: "No model or session endpoints in an auth fixture" });
  });
  server.listen(0, "127.0.0.1", () =>
    console.log(
      "opencode server listening on http://127.0.0.1:" + server.address().port,
    ),
  );
} else {
  if (kind === "claude" && existsSync(credential))
    process.env.LOOP_TEST_CLAUDE_AUTH = readFileSync(
      credential,
      "utf8",
    ).includes('"oauth"')
      ? "oauth"
      : "api";
  await import("./harness.mjs");
}
