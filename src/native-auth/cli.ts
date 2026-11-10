import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { own } from "../processes.js";
import { harnesses } from "../shared/harnesses.js";
import type { AuthDriver } from "./types.js";
import type { AuthOptions } from "./types.js";
import { stopHarnessProcess } from "../native-spawn.js";

// Codex and Grok Build print a device-code URL and code; Claude Code prints a
// URL and reads a pasted code. Credentials stay in each CLI's own store.
export function cliDriver(options: AuthOptions): AuthDriver {
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
      await stopHarnessProcess(child);
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
            ...(grok ? harnesses.grok.environment : {}),
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
          void stopHarnessProcess(process);
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
            void stopHarnessProcess(process);
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
      await stopHarnessProcess(child);
    },
  };
}
