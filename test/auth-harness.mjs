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
// Gemini signs in from a throwaway workspace, not the project or HOME.
if (process.env.LOOP_TEST_CLEAN_ENV === "1" &&
    (process.env.LOOP_TEST_HOST_ONLY ||
      (kind !== "gemini" && process.env.HOME !== process.cwd()))) {
  process.exit(91);
}
const path =
  process.env.LOOP_TEST_AUTH_DIR ||
  (kind === "gemini" ? process.env.HOME : process.cwd());
const credential = path + "/" + kind + "-credential.json";
const finish = path + "/authorize-" + kind;
const save = (method, key = "fixture-token-private") =>
  writeFileSync(credential, JSON.stringify({ method, key }), { mode: 0o600 });
const audit = (message) =>
  appendFileSync(path + "/auth-audit", kind + ":" + message + "\n");
if (process.argv.includes("--version")) {
  console.log(
    { codex: "0.159.0", claude: "2.1.284", pi: "0.87.1", opencode: "1.18.33", gemini: "0.65.0", muse: "Muse Code 1.4.12 (1.4.12-R6909.1)" }[
      kind
    ],
  );
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
        provider,
      });
    }
  });
} else if (kind === "muse" && process.argv[2] === "serve") {
  // Muse's account surface is the MSP fixture; credentials stay in `path`.
  audit("login");
  process.env.LOOP_TEST_MUSE_DIR = path;
  await import("./fixtures/fake-muse.mjs");
} else if (kind === "gemini" && process.argv[2] === "--acp") {
  audit("login");
  const selected = JSON.parse(
    readFileSync(process.cwd() + "/.gemini/settings.json", "utf8"),
  ).security.auth.selectedType;
  if (
    selected !== "oauth-personal" ||
    process.env.NO_BROWSER !== "true" ||
    process.env.GEMINI_CLI_TRUST_WORKSPACE !== "true"
  )
    process.exit(1);
  if (process.env.LOOP_TEST_GEMINI_CACHED) {
    // Cached credentials: no sign-in screen, straight to ACP.
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "authenticate") audit("authenticate");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\n");
    });
  } else {
  const ask = () =>
    process.stdout.write(
      "\x1b[?1049hPlease visit the following URL to authorize the application:\n\n" + (process.env.LOOP_TEST_GEMINI_URL || "https://accounts.google.com/o/oauth2/v2/auth?state=fixture") + "\n\n\x1b[1G\x1b[0JEnter the authorization code: ",
    );
  // A slow start opens the sign-in screen late.
  setTimeout(ask, Number(process.env.LOOP_TEST_GEMINI_DELAY_MS || 0));
  let authorized = false;
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!authorized) {
      if (line !== "fixture-code") {
        process.stderr.write(
          "Failed to authenticate with authorization code:invalid_grant\n",
        );
        return ask();
      }
      authorized = true;
      save("oauth");
      return process.stdout.write("\x1b[?1049l");
    }
    const message = JSON.parse(line);
    if (message.method === "authenticate") {
      if (message.params.methodId !== "oauth-personal") process.exit(1);
      audit("authenticate");
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\n",
    );
  });
  }
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
