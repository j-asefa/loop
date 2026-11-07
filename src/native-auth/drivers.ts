import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { Native } from "../native.js";
import { museHost } from "../adapters/muse.js";
import { own, killOwned } from "../processes.js";
import type {
  AuthDriver,
  AuthInteraction,
  AuthOptions,
} from "../server/native-auth.js";
import type { AuthProvider } from "../shared/native-auth.js";

async function stop(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      killOwned(child, "SIGKILL");
      resolve();
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killOwned(child, "SIGTERM");
  });
}

// Codex and Grok Build print a device-code URL and code; Claude Code prints a
// URL and reads a pasted code. Credentials stay in each CLI's own store.
function cliDriver(options: AuthOptions): AuthDriver {
  let child: ChildProcess | undefined;
  const codex = options.name === "codex";
  const grok = options.name === "grok";
  const device = codex || grok;
  return {
    async providers() {
      return [
        {
          id: codex ? "openai" : grok ? "xai" : "anthropic",
          name: codex ? "ChatGPT" : grok ? "Grok" : "Claude",
          methods: codex
            ? [{ id: "oauth", type: "oauth", label: "Sign in with ChatGPT" }]
            : grok
              ? [{ id: "oauth", type: "oauth", label: "Sign in with Grok" }]
              : [
                  { id: "oauth", type: "oauth", label: "Sign in with Claude" },
                  {
                    id: "console",
                    type: "oauth",
                    label: "Anthropic Console (API billing)",
                  },
                ],
        },
      ];
    },
    async login(_provider, method, io) {
      await stop(child);
      const process = (child = spawn(
        options.executable,
        device
          ? ["login", "--device-auth"]
          : [
              "auth",
              "login",
              method === "console" ? "--console" : "--claudeai",
            ],
        {
          cwd: options.project,
          env: {
            ...(options.env ?? globalThis.process.env),
            BROWSER: "false",
            DISABLE_AUTOUPDATER: "1",
            GROK_DISABLE_AUTOUPDATER: "1",
          },
          stdio: "pipe",
          detached: true,
        },
      ));
      own(process);
      await new Promise<void>((resolve, reject) => {
        let output = "",
          asked = false;
        const abort = () => {
          void stop(process);
          reject(new Error("Sign-in cancelled"));
        };
        io.signal.addEventListener("abort", abort, { once: true });
        const consume = (chunk: Buffer) => {
          try {
            if (io.signal.aborted) return;
            output = (output + chunk.toString())
              .replace(/\x1b\[[0-9;]*m/g, "")
              .slice(-20000);
            const url = (
              output.match(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g) || []
            ).find((value) => {
              try {
                const parsed = new URL(value);
                return (
                  !parsed.username &&
                  !parsed.password &&
                  (codex
                    ? /(^|\.)(openai\.com|chatgpt\.com)$/
                    : grok
                      ? /^accounts\.x\.ai$/
                      : /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/
                  ).test(parsed.hostname)
                );
              } catch {
                return false;
              }
            });
            if (url)
              io.link(
                url,
                device
                  ? output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0]
                  : undefined,
              );
            if (
              url &&
              !asked &&
              /(?:paste|enter)[^\n]*code/i.test(output) &&
              !device
            ) {
              asked = true;
              void io
                .prompt({
                  type: "manual_code",
                  message: "Paste the verification code from Claude",
                })
                .then(
                  (value) => {
                    if (!io.signal.aborted) process.stdin?.write(value + "\n");
                  },
                  () => {},
                );
            }
          } catch {
            void stop(process);
            reject(new Error("Unsupported sign-in response"));
          }
        };
        process.stdout!.on("data", consume);
        process.stderr!.on("data", consume);
        process.stdin!.on("error", () => {});
        process.once("error", () => {
          io.signal.removeEventListener("abort", abort);
          reject(new Error("Sign-in process failed"));
        });
        process.once("exit", (code) => {
          output = "";
          io.signal.removeEventListener("abort", abort);
          code === 0 ? resolve() : reject(new Error("Sign-in failed"));
        });
        if (io.signal.aborted) abort();
      });
    },
    async dispose() {
      await stop(child);
    },
  };
}

async function piDriver(options: AuthOptions): Promise<AuthDriver> {
  const native = new Native(
    options.executable,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--extension",
      fileURLToPath(new URL("../pi-auth-extension.mjs", import.meta.url)),
    ],
    options.project,
    options.env,
  );
  const channel = native.child.stdio[3] as Duplex;
  let dead = false;
  let current:
    | { io: AuthInteraction; resolve(): void; reject(error: Error): void }
    | undefined;
  let logout: { resolve(): void; reject(error: Error): void } | undefined;
  let modelRequest:
    { resolve(models: unknown): void; reject(error: Error): void } | undefined;
  const prompts = new Map<string, AbortController>();
  const providers = await new Promise<AuthProvider[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Pi authentication setup timed out")),
      20000,
    );
    native.on("failure", () => {
      dead = true;
      logout?.reject(new Error("Pi sign-out process exited"));
      modelRequest?.reject(new Error("Pi catalog process exited"));
      clearTimeout(timer);
      reject(new Error("Pi authentication process exited"));
      current?.reject(new Error("Pi authentication process exited"));
      current = undefined;
    });
    native.on("metadata", (message) => {
      if (message.type === "providers") {
        clearTimeout(timer);
        resolve(message.providers);
      }
      if (message.type === "logout_complete") logout?.resolve();
      if (message.type === "models") modelRequest?.resolve(message.models);
      if (message.type === "models_failed")
        modelRequest?.reject(new Error("Pi catalog refresh failed"));
      if (message.type === "logout_failed")
        logout?.reject(new Error("Pi sign-out failed"));
      const login = current;
      if (!login || login.io.signal.aborted) return;
      if (message.type === "link")
        login.io.link(message.url, message.code, message.instructions);
      if (message.type === "prompt") {
        const controller = new AbortController();
        prompts.set(message.id, controller);
        void login.io
          .prompt(message.prompt, controller.signal)
          .then(
            (value) => {
              if (
                !controller.signal.aborted &&
                current === login &&
                !login.io.signal.aborted
              )
                channel.write(
                  JSON.stringify({ type: "input", id: message.id, value }) +
                    "\n",
                );
            },
            (error) => {
              if (
                !controller.signal.aborted &&
                current === login &&
                !login.io.signal.aborted
              ) {
                current = undefined;
                login.reject(
                  error instanceof Error
                    ? error
                    : new Error("Pi sign-in prompt failed"),
                );
              }
            },
          )
          .finally(() => prompts.delete(message.id));
      }
      if (message.type === "clear_prompt") prompts.get(message.id)?.abort();
      if (message.type === "complete") {
        login.resolve();
        current = undefined;
      }
      if (message.type === "failed") {
        login.reject(new Error("Pi sign-in failed"));
        current = undefined;
      }
    });
  }).catch(async (error) => {
    await native.dispose();
    throw error;
  });
  return {
    get dead() {
      return dead;
    },
    async providers() {
      return providers;
    },
    async models() {
      if (dead) throw new Error("Pi authentication process exited");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise((resolve, reject) => {
          modelRequest = { resolve, reject };
          timer = setTimeout(
            () => reject(new Error("Pi catalog refresh timed out")),
            30000,
          );
          channel.write(JSON.stringify({ type: "models" }) + "\n");
        });
      } finally {
        clearTimeout(timer);
        modelRequest = undefined;
      }
    },
    async logout(provider) {
      if (dead || current || logout)
        throw new Error("Pi account process unavailable");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          logout = { resolve, reject };
          timer = setTimeout(
            () => reject(new Error("Pi sign-out timed out")),
            20000,
          );
          channel.write(JSON.stringify({ type: "logout", provider }) + "\n");
        });
      } finally {
        clearTimeout(timer);
        logout = undefined;
      }
    },
    login(provider, method, io) {
      return new Promise<void>((resolve, reject) => {
        if (dead) return reject(new Error("Pi authentication process exited"));
        current = { io, resolve, reject };
        channel.write(
          JSON.stringify({ type: "login", provider, method }) + "\n",
        );
      });
    },
    async dispose() {
      modelRequest?.reject(new Error("Catalog cancelled"));
      logout?.reject(new Error("Sign-out cancelled"));
      current?.reject(new Error("Sign-in cancelled"));
      current = undefined;
      for (const prompt of prompts.values()) prompt.abort();
      await native.dispose();
    },
  };
}

async function openCodeDriver(options: AuthOptions): Promise<AuthDriver> {
  const password = randomBytes(32).toString("hex");
  const authOverride = !!(options.env ?? process.env).OPENCODE_AUTH_CONTENT;
  const child = spawn(
    options.executable,
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: options.project,
      detached: true,
      stdio: "pipe",
      env: {
        ...(options.env ?? process.env),
        OPENCODE_SERVER_USERNAME: "loop",
        OPENCODE_SERVER_PASSWORD: password,
      },
    },
  );
  own(child);
  child.stderr.resume();
  const origin = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("OpenCode authentication setup timed out")),
      20000,
    );
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("OpenCode exited"));
    };
    child.on("error", fail);
    child.on("exit", fail);
    child.stdout.on("data", (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-16000);
      const url = buffer.match(
        /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
  }).catch(async (error) => {
    await stop(child);
    throw error;
  });
  const api = async (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    signal = AbortSignal.timeout(15000),
  ) => {
    const response = await fetch(origin + path, {
      method,
      signal,
      redirect: "error",
      headers: {
        Authorization:
          "Basic " + Buffer.from("loop:" + password).toString("base64"),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error("OpenCode authentication failed");
    return response.json();
  };
  let methods: Record<string, any[]> = {};
  return {
    async providers() {
      const [catalog, auth] = await Promise.all([
        api("/provider"),
        api("/provider/auth"),
      ]);
      methods = auth;
      return catalog.all.map((provider: any) => ({
        id: provider.id,
        name: provider.name,
        configured: catalog.connected.includes(provider.id),
        source:
          provider.source === "env" ||
          (authOverride && ["api", "custom"].includes(provider.source))
            ? "environment"
            : provider.source === "api"
              ? "stored"
              : provider.source === "config"
                ? "configuration"
                : "unknown",
        ...(provider.source === "api"
          ? { credentialType: "api" as const }
          : {}),
        // Configuration/custom availability is not evidence of stored auth.
        // OpenCode's public catalog only identifies stored API credentials.
        removable: !authOverride && provider.source === "api",
        methods: (auth[provider.id] || [{ type: "api", label: "API key" }]).map(
          (method: any, index: number) => ({
            id: String(index),
            label: method.label,
            type: method.type,
          }),
        ),
      }));
    },
    async login(provider, method, io) {
      const entry = methods[provider]?.[Number(method)] || { type: "api" };
      const path = encodeURIComponent(provider);
      if (entry.type === "api") {
        const key = await io.prompt({
          type: "secret",
          message: "Enter your provider API key",
        });
        await api("/auth/" + path, { type: "api", key }, "PUT", io.signal);
      } else {
        const inputs: Record<string, string> = {};
        for (const prompt of entry.prompts || []) {
          const condition = prompt.when ?? prompt.condition;
          if (
            condition &&
            (condition.op === "eq"
              ? inputs[condition.key] !== condition.value
              : inputs[condition.key] === condition.value)
          )
            continue;
          inputs[prompt.key] = await io.prompt({
            type: prompt.type === "select" ? "select" : "text",
            message: prompt.message,
            options: prompt.options?.map((option: any) => ({
              id: option.value,
              label: option.label,
            })),
          });
        }
        const authorization = await api(
          `/provider/${path}/oauth/authorize`,
          { method: Number(method), inputs },
          "POST",
          io.signal,
        );
        if (!["code", "auto"].includes(authorization.method))
          throw new Error("Unsupported authorization method");
        io.link(authorization.url, undefined, authorization.instructions);
        const code =
          authorization.method === "code"
            ? await io.prompt({
                type: "manual_code",
                message:
                  authorization.instructions ||
                  "Paste the provider verification code",
              })
            : undefined;
        if (
          (await api(
            `/provider/${path}/oauth/callback`,
            { method: Number(method), code },
            "POST",
            io.signal,
          )) !== true
        )
          throw new Error("Provider did not confirm authentication");
      }
      const catalog = await api("/provider");
      if (!catalog.connected.includes(provider))
        throw new Error("Provider did not confirm authentication");
    },
    async logout(provider) {
      await api("/auth/" + encodeURIComponent(provider), undefined, "DELETE");
    },
    async models() {
      const catalog = await api("/provider");
      return catalog.all
        .filter((p: any) => catalog.connected.includes(p.id))
        .flatMap((p: any) =>
          Object.entries(p.models || {}).map(([id, m]: [string, any]) => ({
            id: p.id + "/" + id,
            name: m.name || id,
          })),
        );
    },
    async dispose() {
      await stop(child);
    },
  };
}

// agy has no login command; its terminal UI signs in. Run it under script(1)
// for a terminal wide enough to print Google's URL on one line, choose Google
// OAuth and type back the code that antigravity.google shows. agy stores the
// credential; `agy models`, the adapter's own sign-in check, confirms it.
let antigravityExchangeWait = 90000;
let antigravityStartWait = 30000;
export function setAntigravityExchangeWait(ms: number) {
  antigravityExchangeWait = ms;
}
export function setAntigravityStartWait(ms: number) {
  antigravityStartWait = ms;
}
function antigravityDriver(options: AuthOptions): AuthDriver {
  let child: ChildProcess | undefined;
  const env = {
    ...(options.env ?? process.env),
    BROWSER: "false",
    // script(1) runs the command with $SHELL; keep its syntax predictable.
    SHELL: "/bin/sh",
    TERM: (options.env ?? process.env).TERM || "xterm-256color",
    LOOP_AGY: options.executable,
  };
  // Sign-in checks end with their attempt, never overlapping the next one.
  const checks = new Set<ChildProcess>();
  const stopAll = () =>
    Promise.all([stop(child), ...[...checks].map((check) => stop(check))]);
  const signedIn = () =>
    new Promise<boolean>((resolve) => {
      const check = spawn(options.executable, ["models"], {
        cwd: options.project,
        env: options.env ?? process.env,
        stdio: "ignore",
        detached: true,
      });
      own(check);
      checks.add(check);
      const timer = setTimeout(() => void stop(check), 20000);
      check.once("error", () => {
        checks.delete(check);
        resolve(false);
      });
      check.once("exit", (code) => {
        checks.delete(check);
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  return {
    async providers() {
      return [
        {
          id: "google",
          name: "Google",
          methods: [
            { id: "oauth", type: "oauth", label: "Sign in with Google" },
          ],
        },
      ];
    },
    async login(_provider, _method, io) {
      await stopAll();
      // A signed-in agy opens its chat screen instead of the sign-in menu.
      if (await signedIn()) return;
      if (io.signal.aborted) throw new Error("Sign-in cancelled");
      const shell = 'stty cols 4000 rows 200 2>/dev/null; exec "$LOOP_AGY"';
      const process = (child = spawn(
        "script",
        globalThis.process.platform === "darwin"
          ? ["-q", "/dev/null", "/bin/sh", "-c", shell]
          : ["-qfec", shell, "/dev/null"],
        { cwd: options.project, env, stdio: "pipe", detached: true },
      ));
      own(process);
      try {
        await new Promise<void>((resolve, reject) => {
          let output = "",
            phase: "menu" | "link" | "code" | "exchange" = "menu",
            timer: ReturnType<typeof setTimeout> | undefined,
            done = false;
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            io.signal.removeEventListener("abort", abort);
            error ? reject(error) : resolve();
          };
          const abort = () => finish(new Error("Sign-in cancelled"));
          io.signal.addEventListener("abort", abort, { once: true });
          const confirm = async () => {
            while (!done && phase === "exchange") {
              if (await signedIn()) return finish();
              await new Promise((wait) => setTimeout(wait, 1500));
            }
          };
          process.stdout!.on("data", (chunk: Buffer) => {
            if (done) return;
            output = (output + chunk.toString())
              .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
              .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
              .slice(-40000);
            // Wait for the highlighted choice; the menu can arrive in chunks.
            const choice =
              phase === "menu" && /Select login method/.test(output)
                ? output.match(/>\s*1\.\s*([^\n]*?)\s*\n\s*2\./)?.[1]
                : undefined;
            if (choice) {
              // Only the default first choice is accepted: Google OAuth.
              if (!/^Google OAuth$/.test(choice))
                return finish(new Error("Unsupported sign-in response"));
              phase = "link";
              output = "";
              process.stdin!.write("\r");
            } else if (
              phase === "link" &&
              /paste the authorization code/i.test(output)
            ) {
              const url = (output.match(/https:\/\/[^\s<>"']+/g) || []).find(
                (value) => {
                  try {
                    const parsed = new URL(value);
                    return (
                      parsed.hostname === "accounts.google.com" &&
                      !parsed.username &&
                      !parsed.password
                    );
                  } catch {
                    return false;
                  }
                },
              );
              if (!url)
                return finish(new Error("Unsupported sign-in response"));
              phase = "code";
              // The person now has the link; the shared expiry covers them.
              clearTimeout(timer);
              try {
                io.link(url);
              } catch {
                return finish(new Error("Unsupported sign-in response"));
              }
              void io
                .prompt({
                  type: "manual_code",
                  message: "Paste the authorization code from Antigravity",
                })
                .then(
                  (value) => {
                    if (done) return;
                    phase = "exchange";
                    output = "";
                    // One line of printable characters: no terminal controls.
                    process.stdin!.write(
                      value.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, "") + "\r",
                    );
                    timer = setTimeout(
                      () => finish(new Error("Sign-in timed out")),
                      antigravityExchangeWait,
                    );
                    void confirm();
                  },
                  () => {},
                );
            } else if (phase === "exchange" && /Got an error/.test(output))
              finish(new Error("Sign-in failed"));
          });
          process.stderr!.resume();
          process.stdin!.on("error", () => {});
          process.once("error", () =>
            finish(new Error("Sign-in process failed")),
          );
          // agy may exit once it saves the credential; let agy models decide.
          process.once("exit", () => {
            if (done) return;
            if (phase !== "exchange")
              return finish(new Error("Sign-in failed"));
            void signedIn().then((ok) =>
              finish(ok ? undefined : new Error("Sign-in failed")),
            );
          });
          // An agy that stalls before its link ends the attempt.
          timer = setTimeout(
            () => finish(new Error("Sign-in timed out")),
            antigravityStartWait,
          );
          if (io.signal.aborted) abort();
        });
      } finally {
        await stopAll();
      }
    },
    async dispose() {
      await stopAll();
    },
  };
}

// Muse Code's MSP host owns sign-in: a device-code flow for a Meta account or
// a stored API key. Credentials stay in Muse's own store.
async function museDriver(options: AuthOptions): Promise<AuthDriver> {
  const { native } = await museHost(
    options.executable,
    options.project,
    options.env,
  );
  let dead = false;
  let current: ((outcome: string) => void) | undefined;
  native.on("failure", () => {
    dead = true;
    current?.("failed");
  });
  native.on("message", (m) => {
    if (m.method === "account/loginCompleted") current?.(m.params?.outcome);
    if (m.id !== undefined && m.method)
      void native
        .write({
          id: m.id,
          error: { code: -32601, message: "Unsupported Loop client request" },
        })
        .catch(() => {});
  });
  const configured = async () => {
    const account = await native.request("account/read", {});
    return ["accountLogin", "apiKey", "envKey"].includes(account.state);
  };
  return {
    get dead() {
      return dead;
    },
    async providers() {
      return [
        {
          id: "meta",
          name: "Meta",
          configured: await configured(),
          methods: [
            { id: "oauth", type: "oauth", label: "Sign in with Meta" },
            { id: "api", type: "api", label: "Meta API key" },
          ],
        },
      ];
    },
    async logout() {
      await native.request("account/logout", {});
    },
    async login(_provider, method, io) {
      if (dead) throw new Error("Muse Code account process exited");
      let settle!: (outcome: string) => void;
      const outcome = new Promise<string>((resolve) => (settle = resolve));
      current = settle;
      // Muse reports the cancelled flow before answering loginCancel, so
      // settle only then: a late outcome must not reach the next login.
      const abort = () =>
        void native
          .request("account/loginCancel", {})
          .catch(() => {})
          .finally(() => settle("cancelled"));
      io.signal.addEventListener("abort", abort, { once: true });
      try {
        if (method === "api") {
          const apiKey = await io.prompt({
            type: "secret",
            message: "Enter your Meta API key",
          });
          await native.request("account/loginStart", {
            type: "apiKey",
            apiKey,
          });
        } else {
          const flow = await native.request("account/loginStart", {
            type: "deviceCode",
          });
          if (new URL(flow.verificationUrl).hostname !== "auth.meta.com")
            throw new Error("Unsupported sign-in response");
          io.link(flow.verificationUrl, flow.userCode);
          if ((await outcome) !== "granted") throw new Error("Sign-in failed");
        }
        // An API key settles with loginStart itself; the account state, not a
        // completion notification, confirms it.
        if (!(await configured()))
          throw new Error("Provider did not confirm authentication");
      } finally {
        if (current === settle) current = undefined;
        io.signal.removeEventListener("abort", abort);
      }
    },
    async dispose() {
      current?.("cancelled");
      await native.dispose();
    },
  };
}

export async function createAuthDriver(
  options: AuthOptions,
): Promise<AuthDriver> {
  if (["codex", "claude", "grok"].includes(options.name))
    return cliDriver(options);
  if (options.name === "pi") return piDriver(options);
  if (options.name === "opencode") return openCodeDriver(options);
  if (options.name === "muse") return museDriver(options);
  if (options.name === "antigravity") return antigravityDriver(options);
  throw new Error("Unsupported sign-in harness");
}
