import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
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

function cliDriver(options: AuthOptions): AuthDriver {
  let child: ChildProcess | undefined;
  const codex = options.name === "codex";
  return {
    async providers() {
      return [
        {
          id: codex ? "openai" : "anthropic",
          name: codex ? "ChatGPT" : "Claude",
          methods: codex
            ? [{ id: "oauth", type: "oauth", label: "Sign in with ChatGPT" }]
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
        codex
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
                codex
                  ? output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0]
                  : undefined,
              );
            if (
              url &&
              !asked &&
              /(?:paste|enter)[^\n]*code/i.test(output) &&
              !codex
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
  const prompts = new Map<string, AbortController>();
  const providers = await new Promise<AuthProvider[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Pi authentication setup timed out")),
      20000,
    );
    native.on("failure", () => {
      dead = true;
      logout?.reject(new Error("Pi sign-out process exited"));
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
      if (message.type === "logout_failed") logout?.reject(new Error("Pi sign-out failed"));
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
      const result = await native.request("get_available_models", {}, false);
      return result.models;
    },
    async logout(provider) {
      if (dead || current || logout) throw new Error("Pi account process unavailable");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          logout = { resolve, reject };
          timer = setTimeout(() => reject(new Error("Pi sign-out timed out")), 20000);
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
    async dispose() {
      await stop(child);
    },
  };
}

// Gemini has no login command. With Google sign-in selected and NO_BROWSER,
// `gemini --acp` runs its own user-code exchange on stdin before serving ACP.
// A throwaway trusted workspace selects Google for this process only; ACP
// `authenticate` then lets Gemini save the chosen method in its user settings.
let geminiSignInScreenWait = 15000;
/** Tests shorten the cached-credential wait. */
export function setGeminiSignInScreenWait(ms: number) {
  geminiSignInScreenWait = ms;
}
function geminiDriver(options: AuthOptions): AuthDriver {
  let child: ChildProcess | undefined;
  let workspace: string | undefined;
  const cleanup = async () => {
    await stop(child);
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  };
  return {
    async providers() {
      return [
        {
          id: "google",
          name: "Google",
          methods: [{ id: "oauth", type: "oauth", label: "Sign in with Google" }],
        },
      ];
    },
    async login(_provider, _method, io) {
      await cleanup();
      workspace = await mkdtemp(join(tmpdir(), "loop-gemini-sign-in-"));
      await mkdir(join(workspace, ".gemini"));
      await writeFile(
        join(workspace, ".gemini", "settings.json"),
        JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
      );
      const process = (child = spawn(options.executable, ["--acp"], {
        cwd: workspace,
        env: {
          ...(options.env ?? globalThis.process.env),
          NO_BROWSER: "true",
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        },
        stdio: "pipe",
        detached: true,
      }));
      own(process);
      try {
        await new Promise<void>((resolve, reject) => {
          let output = "",
            late = "",
            assumed = false,
            phase: "link" | "code" | "exchange" | "acp" = "link";
          // Cached Google credentials skip the code exchange: Gemini never
          // opens its sign-in screen and goes straight to serving ACP. Let
          // ACP authenticate confirm them instead of waiting for a URL.
          const cached = setTimeout(() => {
            if (phase !== "link" || output.includes("\x1b[?1049h")) return;
            assumed = true;
            phase = "acp";
            output = "";
            begin();
          }, geminiSignInScreenWait);
          const abort = () => {
            clearTimeout(cached);
            void stop(process);
            reject(new Error("Sign-in cancelled"));
          };
          io.signal.addEventListener("abort", abort, { once: true });
          const fail = (message: string) => {
            clearTimeout(cached);
            void stop(process);
            reject(new Error(message));
          };
          const send = (id: number, method: string, params: unknown) =>
            process.stdin!.write(
              JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
            );
          const begin = () => {
            clearTimeout(cached);
            send(1, "initialize", {
              protocolVersion: PROTOCOL_VERSION,
              clientInfo: { name: "Loop", version: "0.1.0" },
              clientCapabilities: {},
            });
          };
          // The last Google authorization URL before Gemini's code prompt.
          const relay = (text: string) => {
            const url = (text.match(/https:\/\/[^\s<>"'\x1b]+/g) || [])
              .filter((value) => {
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
              })
              .pop();
            if (!url) return fail("Unsupported sign-in response");
            // The sign-in screen is real now; later ACP output is genuine.
            assumed = false;
            late = "";
            phase = "code";
            clearTimeout(cached);
            try {
              io.link(url);
            } catch {
              return fail("Unsupported sign-in response");
            }
            void io
                .prompt({
                  type: "manual_code",
                  message: "Paste the authorization code from Google",
                })
                .then(
                  (value) => {
                    if (io.signal.aborted) return;
                    phase = "exchange";
                    output = "";
                    // One line only: later stdin lines are ACP frames.
                    process.stdin!.write(value.replace(/\s+/g, "") + "\n");
                  },
                  () => {},
                );
          };
          process.stdout!.on("data", (chunk: Buffer) => {
            if (io.signal.aborted) return;
            output = (output + chunk.toString()).slice(-20000);
            if (phase === "link") {
              if (/Enter the authorization code/.test(output)) relay(output);
            } else if (phase === "exchange") {
              // Gemini leaves its sign-in screen once the code is accepted.
              if (!output.includes("\x1b[?1049l")) return;
              phase = "acp";
              output = "";
              begin();
            } else if (phase === "acp") {
              // A slow, signed-out start can open the sign-in screen after Loop
              // assumed cached credentials. Gemini reads Loop's initialize
              // frame as a bad code and asks again with a new URL: relay that
              // second prompt so the person can still sign in.
              if (assumed) {
                late = (late + chunk.toString()).slice(-40000);
                const prompts = late.match(/Enter the authorization code/g);
                if (prompts && prompts.length >= 2) return relay(late);
                if (prompts) return;
              }
              let end;
              while ((end = output.indexOf("\n")) >= 0) {
                const line = output.slice(0, end).trim();
                output = output.slice(end + 1);
                if (!line.startsWith("{")) continue;
                let message;
                try {
                  message = JSON.parse(line);
                } catch {
                  return fail("Unsupported sign-in response");
                }
                if (message.error) return fail("Sign-in failed");
                if (message.id === 1)
                  send(2, "authenticate", { methodId: "oauth-personal" });
                if (message.id === 2) {
                  io.signal.removeEventListener("abort", abort);
                  return resolve();
                }
              }
            }
          });
          // Gemini reports a rejected code on stderr, then asks again. End
          // the attempt rather than relaying a second authorization URL. (A
          // late sign-in screen's rejection of Loop's frame is expected.)
          process.stderr!.on("data", (chunk: Buffer) => {
            if (
              phase === "exchange" &&
              /Failed to authenticate/.test(chunk.toString())
            )
              fail("Sign-in failed");
          });
          process.stdin!.on("error", () => {});
          process.once("error", () => {
            io.signal.removeEventListener("abort", abort);
            reject(new Error("Sign-in process failed"));
          });
          process.once("exit", () => {
            clearTimeout(cached);
            io.signal.removeEventListener("abort", abort);
            reject(new Error("Sign-in failed"));
          });
          if (io.signal.aborted) abort();
        });
      } finally {
        await cleanup();
      }
    },
    async dispose() {
      await cleanup();
    },
  };
}

// Muse Code's MSP host owns sign-in: a device-code flow for a Meta account or
// a stored API key. Credentials stay in Muse's own store.
async function museDriver(options: AuthOptions): Promise<AuthDriver> {
  const { native } = await museHost(options.executable, options.project, options.env);
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
  if (options.name === "codex" || options.name === "claude")
    return cliDriver(options);
  if (options.name === "pi") return piDriver(options);
  if (options.name === "opencode") return openCodeDriver(options);
  if (options.name === "gemini") return geminiDriver(options);
  if (options.name === "muse") return museDriver(options);
  throw new Error("Unsupported sign-in harness");
}
